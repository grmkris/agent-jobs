/**
 * Execution budget (ADR-0005) on a local anvil fork of Monad testnet: declared costs in quotes, the approved budget
 * frozen into the offer, and the grant/spend lifecycle. Privy is a test double here that enforces what the live
 * spike proved it enforces (the board key's signature, the policy's per-transfer cap, token and expiry, the signer
 * being attached, idempotency) and sends the transfer from the creator on the fork; the real Privy is exercised by
 * `scripts/budget-spike.ts` and the live run. Nothing is sent to the real chain.
 *
 * Needs MONAD_TESTNET_RPC_URL and `anvil` on PATH; skipped otherwise.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@agent-jobs/sdk'
import { type AbiFunction, type Address, type Hex, decodeFunctionData, encodeFunctionData, erc20Abi, parseAbi, parseAbiItem, parseEther, parseSignature, parseUnits } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Board, type BoardConfig, type BudgetInput, fromNodeSqlite, generateAuthorizationKey, parseTerms, signaturePayload } from './index.ts'

const rpc = process.env.MONAD_TESTNET_RPC_URL ?? ''
const hasAnvil = (() => {
  try {
    execFileSync('anvil', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const fork = rpc === '' || !hasAnvil ? describe.skip : describe
const PORT = 8662
const url = `http://127.0.0.1:${PORT}`
const NET = 'monad-testnet' as const

let anvil: ChildProcess | undefined
const ctx = () => sdk.context(NET, 'demo', url)

/** Like `rpcCall`, but a JSON-RPC error throws instead of reading as an undefined result. */
async function rpcStrict(method: string, params: unknown[]) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const body = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

async function rpcCall(method: string, params: unknown[]) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return ((await res.json()) as { result: unknown }).result
}

const APP = { appId: 'app-test', appSecret: 'secret' }
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const b64url = (u: Uint8Array | string) =>
  (typeof u === 'string' ? btoa(u) : b64(u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const json = (status: number, x: unknown) => new Response(JSON.stringify(x), { status })
const pad32 = (b: Uint8Array) => [...Array.from({ length: 32 - (b[0] === 0 ? b.length - 1 : b.length) }, () => 0), ...(b[0] === 0 ? b.slice(1) : b)]

/**
 * Privy as the live spike found it: signed wallet RPC under the attached signer's policy, person-owned policies, JWKS
 * access tokens. Transfers are sent from the creator on the fork (impersonated), as Privy sends from the wallet.
 */
const randomBytesHex = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')

class FakePrivy {
  readonly jwt = crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  signerPublic: Awaited<ReturnType<typeof crypto.subtle.importKey>> | undefined
  readonly policies = new Map<string, { rules: Array<{ name: string; conditions: Array<{ field: string; operator: string; value: string; abi?: unknown }> }> }>()
  signers: Array<{ signer_id: string; override_policy_ids: string[] }> = []
  readonly sent = new Map<string, Hex>()
  refuseNextSend = false
  rpcCalls = 0
  /** The embedded wallet's key, for `eth_signTypedData_v4` (Privy signs inside its enclave). */
  signTypedData: ((td: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }) => Promise<Hex>) | undefined
  constructor(
    readonly creator: Address,
    readonly did: string,
  ) {}

  async accessToken(now: number) {
    const k = await this.jwt
    const h = b64url(JSON.stringify({ alg: 'ES256', kid: 'k1' }))
    const p = b64url(JSON.stringify({ iss: 'privy.io', aud: APP.appId, sub: this.did, exp: now + 3600 }))
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.privateKey, new TextEncoder().encode(`${h}.${p}`)))
    return `${h}.${p}.${b64url(sig)}`
  }

  /** The browser's `addSigners`. */
  addSigner(signerId: string, policyId: string) {
    this.signers = [{ signer_id: signerId, override_policy_ids: [policyId] }]
  }

  async #verifySigner(headers: Record<string, string>, requestUrl: string, body: unknown): Promise<boolean> {
    const sig = headers['privy-authorization-signature']
    if (sig === undefined || this.signerPublic === undefined) return false
    const der = unb64(sig)
    const rLen = der[3] as number
    const raw = Uint8Array.from([...pad32(der.slice(4, 4 + rLen)), ...pad32(der.slice(6 + rLen))])
    const payload = signaturePayload({
      method: 'POST', url: requestUrl, body, appId: APP.appId,
      ...(headers['privy-idempotency-key'] === undefined ? {} : { idempotencyKey: headers['privy-idempotency-key'] }),
    })
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, this.signerPublic, raw, payload)
  }

  fetch: typeof fetch = async (input, init) => {
    const u = String(input)
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>)
    if (u.endsWith('/jwks.json')) {
      const jwk = await crypto.subtle.exportKey('jwk', (await this.jwt).publicKey)
      return json(200, { keys: [{ ...jwk, kid: 'k1' }] })
    }
    const path = u.replace('https://api.privy.io/v1', '')
    if (method === 'GET' && path === `/users/${encodeURIComponent(this.did)}`) {
      return json(200, { id: this.did, linked_accounts: [{ type: 'wallet', chain_type: 'ethereum', wallet_client_type: 'privy', address: this.creator, id: 'w1' }] })
    }
    if (method === 'GET' && path === '/wallets/w1') return json(200, { id: 'w1', address: this.creator, additional_signers: this.signers })
    if (method === 'POST' && path === '/policies') {
      const id = `p${this.policies.size + 1}`
      this.policies.set(id, { rules: body?.rules as never })
      return json(200, { id, rules: body?.rules })
    }
    const pol = /^\/policies\/(p\d+)$/.exec(path)
    if (pol !== null) {
      const p = this.policies.get(pol[1] as string)
      if (p === undefined) return json(404, { error: 'no policy' })
      // Person-owned and never edited by the board: a change is a fresh policy.
      if (method === 'GET') return json(200, { id: pol[1], rules: p.rules })
    }
    if (method === 'POST' && path === '/wallets/w1/rpc') {
      this.rpcCalls++
      const key = headers['privy-idempotency-key'] ?? ''
      const seen = this.sent.get(key)
      if (seen !== undefined) return json(200, { data: { hash: seen } })
      if (!(await this.#verifySigner(headers, u, body))) return json(401, { error: 'No valid authorization signatures' })
      if (this.refuseNextSend) {
        this.refuseNextSend = false
        return json(400, { error: 'RPC request denied due to policy violation', code: 'policy_violation' })
      }
      if (body?.method === 'eth_signTypedData_v4') {
        // An x402 rule: the domain's chain and contract, the message's value at most the cap, before the expiry.
        const td = (body.params as { typed_data: { domain: Record<string, unknown>; types: Record<string, unknown>; primary_type: string; message: Record<string, string> } }).typed_data
        const signer = this.signers[0]
        const rules = signer === undefined ? [] : (this.policies.get(signer.override_policy_ids[0] as string)?.rules ?? [])
        const now = Number((await ctx().publicClient.getBlock()).timestamp)
        const allowed = rules.some((r) => {
          const c = (f: string) => r.conditions.find((x) => x.field === f)?.value as string
          return (
            c('chainId') === String(td.domain.chainId) &&
            c('verifyingContract') === td.domain.verifyingContract &&
            BigInt(td.message.value as string) <= BigInt(c('value')) &&
            now < Number(c('current_unix_timestamp'))
          )
        })
        if (!allowed || this.signTypedData === undefined) return json(400, { error: 'RPC request denied due to policy violation', code: 'policy_violation' })
        const signature = await this.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primary_type, message: td.message })
        this.sent.set(key, signature)
        return json(200, { data: { signature } })
      }
      const tx = ((body ?? {}).params as { transaction: { to: Address; data: Hex; value: Hex } }).transaction
      const signer = this.signers[0]
      const rules = signer === undefined ? [] : (this.policies.get(signer.override_policy_ids[0] as string)?.rules ?? [])
      const now = Number((await ctx().publicClient.getBlock()).timestamp)
      const value = BigInt(tx.value)
      const allowed = rules.some((r) => {
        const cond = (f: string) => r.conditions.find((x) => x.field === f)
        const c = (f: string) => cond(f)?.value as string
        if (c('to').toLowerCase() !== tx.to.toLowerCase() || now >= Number(c('current_unix_timestamp'))) return false
        const fn = cond('function_name')
        if (fn !== undefined) {
          // A call rule: this one function (decoded with the rule's ABI) and at most the value cap.
          try {
            return decodeFunctionData({ abi: fn.abi as [AbiFunction], data: tx.data }).functionName === fn.value && value <= BigInt(c('value'))
          } catch {
            return false
          }
        }
        try {
          const { args, functionName } = decodeFunctionData({ abi: erc20Abi, data: tx.data })
          return functionName === 'transfer' && value === 0n && (args[1] as bigint) <= BigInt(c('transfer.amount'))
        } catch {
          return false
        }
      })
      if (!allowed) return json(400, { error: 'RPC request denied due to policy violation', code: 'policy_violation' })
      await rpcCall('anvil_impersonateAccount', [this.creator])
      const hash = (await rpcCall('eth_sendTransaction', [{ from: this.creator, to: tx.to, data: tx.data, value: tx.value }])) as Hex
      this.sent.set(key, hash)
      return json(200, { data: { hash } })
    }
    return json(404, { error: `unhandled ${method} ${path}` })
  }
}

let privy: FakePrivy
let signerKey = ''
/** Seconds the fork's clock was moved ahead; the board's clock follows it, as wall clock and chain agree live. */
let skew = 0

const config = (): BoardConfig => ({
  network: NET,
  contexts: { main: sdk.context(NET, 'main', url), demo: ctx() },
  domain: 'board.test',
  uri: 'https://board.test',
  manifestBaseUrl: 'https://board.test/offers',
  now: () => Math.floor(Date.now() / 1000) + skew,
  budget: { app: APP, signerKey, signerQuorumId: 'q-board', fetch: (i, o) => privy.fetch(i, o) },
})
const now = async () => Number((await ctx().publicClient.getBlock()).timestamp)

fork('execution budget on a testnet fork', () => {
  const db = new DatabaseSync(':memory:')
  const creator = privateKeyToAccount(generatePrivateKey())
  const worker = privateKeyToAccount(generatePrivateKey())
  const stranger = privateKeyToAccount(generatePrivateKey())
  privy = new FakePrivy(creator.address, 'did:privy:creator')
  privy.signTypedData = (td) => creator.signTypedData(td as never)
  let board: Board
  const w = (a: typeof creator) => sdk.wallet(NET, a, url)
  let agentId = ''

  async function signIn(account: typeof creator) {
    const { message } = board.authChallenge({ address: account.address })
    return board.authLogin({ message, signature: await account.signMessage({ message }) })
  }

  beforeAll(async () => {
    const k = await generateAuthorizationKey()
    signerKey = k.privateKey
    privy.signerPublic = await crypto.subtle.importKey('spki', unb64(k.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    board = new Board(fromNodeSqlite(db), config())
    anvil = spawn('anvil', ['--fork-url', rpc, '--port', String(PORT), '--silent'], { stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      const id = await rpcCall('eth_chainId', []).catch(() => undefined)
      if (id !== undefined) break
      await new Promise((r) => setTimeout(r, 500))
    }
    for (const a of [creator, worker, stranger]) await rpcCall('anvil_setBalance', [a.address, `0x${parseEther('100').toString(16)}`])
    const c = ctx()
    // mUSD and mEUR: later reward tokens (e.g. $CHOMP) are real tokens with no faucet
    for (const token of [c.deployment.factory, ...c.deployment.rewardTokens.slice(0, 2)]) await sdk.faucet(c, w(creator), token)
    await sdk.faucet(c, w(worker), c.deployment.factory)
    agentId = (await sdk.registerAgent(c, w(worker), 'https://example.test/agent.json')).toString()
    await signIn(creator)
    await signIn(worker)
    await signIn(stranger)
  }, 120_000)

  afterAll(() => {
    anvil?.kill()
  })

  it('declared costs travel with a quote, change its hash, and the pick freezes the approved budget into the offer', async () => {
    const t = await now()
    const [mUSD, mEUR] = ctx().deployment.rewardTokens as [Hex, Hex]
    const req = await board.requestQuotes({ address: creator.address }, {
      title: 'Budgeted work', brief: 'Fork test.', acceptanceCriteria: ['x'], tokens: ['mUSD'], creatorBond: '1', workerBond: '1',
      deliveryDeadline: t + 3600, quoteDeadline: t + 600, stack: 'demo',
    })
    const plain = await board.submitQuote({ address: worker.address }, { requestId: req.requestId, agentId, token: 'mUSD', amount: '5' })
    const costed = await board.submitQuote({ address: worker.address }, {
      requestId: req.requestId, agentId, token: 'mUSD', amount: '5', expectedCosts: { token: 'mEUR', amount: '2', note: 'model calls' },
    })
    expect(costed.quoteHash).not.toBe(plain.quoteHash)
    await expect(
      board.submitQuote({ address: worker.address }, { requestId: req.requestId, agentId, token: 'mUSD', amount: '5', expectedCosts: { token: 'mEUR', amount: '0' } }),
    ).rejects.toThrow('positive')

    const listed = await board.listQuotes({ address: creator.address }, { requestId: req.requestId })
    const q = listed.quotes[0]
    expect(q?.expectedCosts).toMatchObject({ token: mEUR, symbol: 'mEUR', amount: '2', note: 'model calls' })

    // The creator approves less than asked; the token defaults to the declared costs' token.
    const picked = await board.pickQuote({ address: creator.address }, { requestId: req.requestId, quoteId: q?.quoteId as string, executionBudget: { cap: '1.5' } })
    const terms = parseTerms(picked.manifest as string)
    expect(terms.token.toLowerCase()).toBe(mUSD.toLowerCase())
    expect(terms.executionBudget).toEqual({ token: mEUR, cap: parseUnits('1.5', 6), expiresAt: t + 3600 })
    const index = board.taskIndex({}).find((x) => x.taskId === picked.taskId)
    expect(index?.executionBudget).toEqual({ token: mEUR, cap: parseUnits('1.5', 6).toString(), expiresAt: t + 3600 })
    const seen = await board.getTask({ address: worker.address }, { taskId: picked.taskId })
    expect(seen.executionBudget).toMatchObject({ symbol: 'mEUR', amount: '1.5', expiresAt: t + 3600 })
  }, 180_000)

  it('refuses a budget on a contest, one outliving the delivery deadline, and a token off the allowlist', async () => {
    const t = await now()
    const base = { title: 'x', brief: 'x', acceptanceCriteria: ['x'], token: 'mUSD', reward: '2', creatorBond: '1', stack: 'demo' as const }
    await expect(
      board.createTask({ address: creator.address }, {
        ...base, workerBond: '0', mode: 'contest', deliveryDeadline: t + 3600, selectionDeadline: t + 600, executionBudget: { token: 'mUSD', cap: '1' },
      }),
    ).rejects.toThrow('Only a hire')
    await expect(
      board.createTask({ address: creator.address }, {
        ...base, workerBond: '1', mode: 'hire', deliveryDeadline: t + 3600, executionBudget: { token: 'mUSD', cap: '1', expiresAt: t + 3601 },
      }),
    ).rejects.toThrow('expires')
    await expect(
      board.createTask({ address: creator.address }, {
        ...base, workerBond: '1', mode: 'hire', deliveryDeadline: t + 3600, executionBudget: { token: ctx().deployment.factory, cap: '1' },
      }),
    ).rejects.toThrow('allowlisted')
  }, 180_000)

  /** A hire with a budget, published, the worker selected and activated. */
  async function activeHire(cap: string, expiresIn = 1800, budget?: BudgetInput) {
    const c = ctx()
    const t = await now()
    const created = await board.createTask({ address: creator.address }, {
      title: 'Budgeted hire', brief: 'Fork test.', acceptanceCriteria: ['x'], token: 'mUSD', reward: '2', creatorBond: '1', workerBond: '1',
      deliveryDeadline: t + 3600, mode: 'hire', stack: 'demo', executionBudget: budget ?? { token: 'mEUR', cap, expiresAt: t + expiresIn },
    })
    const hashes = await sdk.sendAll(w(creator), c.publicClient, created.transactions)
    await board.reportTransaction({ address: creator.address }, { taskId: created.taskId, txHash: hashes.at(-1) as string })
    const app = await board.apply({ address: worker.address }, { taskId: created.taskId, agentId, note: 'fork' })
    const sel = await board.selectWorker({ address: creator.address }, { taskId: created.taskId, applicationId: app.applicationId })
    await board.submitSelection({ address: creator.address }, { taskId: created.taskId, nonce: sel.nonce, signature: await sdk.signTypedDataJson(w(creator), sel.sign.typedData) })
    const seen = await board.getTask({ address: worker.address }, { taskId: created.taskId })
    const prep = await board.prepareActivation({ address: worker.address }, { taskId: created.taskId })
    await sdk.sendAll(w(worker), c.publicClient, prep.transactions)
    const act = await board.buildActivation({ address: worker.address }, { taskId: created.taskId, budgetSignature: await sdk.signTypedDataJson(w(worker), prep.sign.typedData) })
    await sdk.sendAll(w(worker), c.publicClient, act.transactions)
    return { taskId: created.taskId, seenBeforeActivation: seen }
  }

  it('grant, spend within the cap, refusals, concurrency, a refused send, revoke and cleanup', async () => {
    const [, mEUR] = ctx().deployment.rewardTokens as [Hex, Hex]
    const sink = privateKeyToAccount(generatePrivateKey()).address
    const { taskId, seenBeforeActivation } = await activeHire('1.5')
    // The worker sees the budget, and that it is only promised, before it commits.
    expect(seenBeforeActivation.executionBudget).toMatchObject({ symbol: 'mEUR', amount: '1.5', grant: 'promised' })
    await expect(board.spendBudget({ address: worker.address }, { taskId, to: sink, amount: '0.1' })).rejects.toThrow('not granted')

    // Grant: first time, a fresh policy and the browser's addSigners.
    const token = await privy.accessToken(await now())
    await expect(board.budgetGrantPrepare({ address: worker.address }, { taskId, privyAccessToken: token })).rejects.toThrow('only the creator')
    const prep = await board.budgetGrantPrepare({ address: creator.address }, { taskId, privyAccessToken: token })
    expect(prep.step).toBe('add-signer')
    await expect(board.budgetGrantConfirm({ address: creator.address }, { taskId })).rejects.toThrow('not on your wallet')
    privy.addSigner((prep as { signerId: string }).signerId, (prep as { policyId: string }).policyId)
    const live = await board.budgetGrantConfirm({ address: creator.address }, { taskId })
    expect(live).toMatchObject({ status: 'live', cap: '1.5', spent: '0', remaining: '1.5', symbol: 'mEUR' })

    // Spend: only the worker, within the ledger.
    await expect(board.spendBudget({ address: stranger.address }, { taskId, to: sink, amount: '0.1' })).rejects.toThrow('activated worker')
    await expect(board.spendBudget({ address: worker.address }, { taskId, to: sink, amount: '0' })).rejects.toThrow('positive')
    const first = await board.spendBudget({ address: worker.address }, { taskId, to: sink, amount: '1', note: 'model calls' })
    await ctx().publicClient.waitForTransactionReceipt({ hash: first.txHash })
    expect(await ctx().publicClient.readContract({ address: mEUR, abi: erc20Abi, functionName: 'balanceOf', args: [sink] })).toBe(parseUnits('1', 6))
    await expect(board.spendBudget({ address: worker.address }, { taskId, to: sink, amount: '1' })).rejects.toThrow('over the budget')

    // Two concurrent spends that each fit, but not together: exactly one is sent.
    const both = await Promise.allSettled([
      board.spendBudget({ address: worker.address }, { taskId, to: sink, amount: '0.3' }),
      board.spendBudget({ address: worker.address }, { taskId, to: sink, amount: '0.3' }),
    ])
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(both.filter((r) => r.status === 'rejected' && String(r.reason).includes('over the budget'))).toHaveLength(1)

    // Privy refuses a send (nothing moves): the reservation is released.
    privy.refuseNextSend = true
    await expect(board.spendBudget({ address: worker.address }, { taskId, to: sink, amount: '0.1' })).rejects.toThrow('Privy refused')
    const after = await board.getBudget({ address: worker.address }, { taskId })
    expect(after.spent).toBe('1.3')
    expect(after.remaining).toBe('0.2')
    expect(after.spends.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'failed'])
    await expect(board.getBudget({ address: stranger.address }, { taskId })).rejects.toThrow('only the creator')

    // Revoke: the board stops signing at once; it was the only budget, so the cleanup is removing the signer.
    const revoked = await board.revokeBudget({ address: creator.address }, { taskId })
    expect(revoked.status).toBe('revoked')
    expect(revoked.cleanup).toMatchObject({ removeSigners: true })
    const calls = privy.rpcCalls
    await expect(board.spendBudget({ address: worker.address }, { taskId, to: sink, amount: '0.1' })).rejects.toThrow('revoked')
    expect(privy.rpcCalls).toBe(calls)
  }, 300_000)

  it('a second budget while the signer is attached swaps it onto a fresh policy; expiry ends a grant', async () => {
    const sink = privateKeyToAccount(generatePrivateKey()).address
    const a = await activeHire('1', 900)
    const token = await privy.accessToken(await now())
    const policiesBefore = privy.policies.size
    const first = await board.budgetGrantPrepare({ address: creator.address }, { taskId: a.taskId, privyAccessToken: token })
    // The signer is still attached from the previous test, under a policy without this budget.
    expect(first.step).toBe('replace-signer')
    const { policyId, signerId } = first as { policyId: string; signerId: string }
    expect(privy.policies.size).toBe(policiesBefore + 1)
    // The fresh policy holds only this grant: the previous test's budget is revoked, the quote test's never granted.
    expect(privy.policies.get(policyId)?.rules.map((r) => r.name)).toEqual([`budget-${a.taskId}`])
    await expect(board.budgetGrantConfirm({ address: creator.address }, { taskId: a.taskId })).rejects.toThrow('without this budget')
    privy.addSigner(signerId, policyId)
    const live = await board.budgetGrantConfirm({ address: creator.address }, { taskId: a.taskId })
    expect(live.status).toBe('live')
    await board.spendBudget({ address: worker.address }, { taskId: a.taskId, to: sink, amount: '0.5' })

    // Past the budget's expiry the board ends the grant and refuses, before asking Privy.
    await rpcCall('evm_increaseTime', [1000])
    await rpcCall('evm_mine', [])
    skew += 1000
    const calls = privy.rpcCalls
    await expect(board.spendBudget({ address: worker.address }, { taskId: a.taskId, to: sink, amount: '0.1' })).rejects.toThrow('ended')
    expect(privy.rpcCalls).toBe(calls)
    const ended = await board.getBudget({ address: creator.address }, { taskId: a.taskId })
    expect(ended).toMatchObject({ status: 'ended', endedReason: 'expired' })
  }, 300_000)

  it('a call budget launches a token on nad.fun from the creator’s wallet: the creator is msg.sender, the value is capped', async () => {
    // nad.fun's bonding-curve router on Monad testnet; `create` costs a 10 MON deploy fee.
    const router = '0x865054F0F6A288adaAc30261731361EA7E908003' as const
    const fn = 'function create((string name,string symbol,string tokenURI,uint256 amountOut,bytes32 salt,uint8 actionId) params) payable'
    const create = parseAbiItem(fn) as AbiFunction
    const t = await now()
    const { taskId, seenBeforeActivation } = await activeHire('12', 1800, { kind: 'call', target: router, function: fn, cap: '12', expiresAt: t + 1800 })
    expect(seenBeforeActivation.executionBudget).toMatchObject({ kind: 'call', target: router, amount: '12', symbol: 'MON', grant: 'promised' })

    const prep = await board.budgetGrantPrepare({ address: creator.address }, { taskId, privyAccessToken: await privy.accessToken(await now()) })
    const { policyId, signerId } = prep as { policyId: string; signerId: string }
    const rule = privy.policies.get(policyId)?.rules.find((r) => r.name === `budget-${taskId}`)
    expect(rule?.conditions.map((c) => c.field)).toEqual(['chain_id', 'to', 'value', 'function_name', 'current_unix_timestamp'])
    privy.addSigner(signerId, policyId)
    expect(await board.budgetGrantConfirm({ address: creator.address }, { taskId })).toMatchObject({ status: 'live', kind: 'call', cap: '12', symbol: 'MON' })

    const salt = `0x${'ab'.repeat(32)}` as Hex
    const data = encodeFunctionData({ abi: [create], args: [{ name: 'Chomp', symbol: 'CHOMP', tokenURI: 'https://example.test/chomp.json', amountOut: 0n, salt, actionId: 1 }] })
    // Only the worker, only that function, only a call budget's tool, only within the cap.
    await expect(board.spendBudgetCall({ address: stranger.address }, { taskId, data, value: '10' })).rejects.toThrow('activated worker')
    await expect(board.spendBudgetCall({ address: worker.address }, { taskId, data: '0xa9059cbb00', value: '0' })).rejects.toThrow('selector')
    await expect(board.spendBudget({ address: worker.address }, { taskId, to: worker.address, amount: '1' })).rejects.toThrow('spend_budget_call')
    await expect(board.spendBudgetCall({ address: worker.address }, { taskId, data, value: '13' })).rejects.toThrow('over the budget')

    const before = await ctx().publicClient.getBalance({ address: creator.address })
    const spent = await board.spendBudgetCall({ address: worker.address }, { taskId, data, value: '10', note: 'nad.fun deploy fee' })
    const receipt = await ctx().publicClient.waitForTransactionReceipt({ hash: spent.txHash })
    expect(receipt.status).toBe('success')
    // The creator sent it, so the launchpad records the creator (not the worker) as the token's creator.
    expect(receipt.from.toLowerCase()).toBe(creator.address.toLowerCase())
    const creatorTopic = `0x${creator.address.slice(2).toLowerCase().padStart(64, '0')}`
    expect(receipt.logs.some((l) => (l.topics as readonly string[]).includes(creatorTopic) || l.data.toLowerCase().includes(creator.address.slice(2).toLowerCase()))).toBe(true)
    expect(before - (await ctx().publicClient.getBalance({ address: creator.address }))).toBeGreaterThanOrEqual(parseEther('10'))

    const after = await board.getBudget({ address: creator.address }, { taskId })
    expect(after).toMatchObject({ spent: '10', remaining: '2' })
    expect(after.spends[0]).toMatchObject({ selector: data.slice(0, 10), status: 'confirmed' })
    await expect(board.spendBudgetCall({ address: worker.address }, { taskId, data, value: '10' })).rejects.toThrow('over the budget')
  }, 300_000)

  it('an x402 budget signs capped payment authorizations; the ledger settles them on-chain or releases them', async () => {
    const usdc = ctx().deployment.x402?.usdc as Address
    const minter = '0x87f2e95621D8f12b83bb4a3E9975c0eAd524D437' as const // the testnet USDC's masterMinter
    const usdcAbi = parseAbi([
      'function configureMinter(address minter, uint256 allowance) returns (bool)',
      'function mint(address to, uint256 amount) returns (bool)',
      'function balanceOf(address) view returns (uint256)',
      'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
    ])

    const t = await now()
    const { taskId, seenBeforeActivation } = await activeHire('1', 1800, { kind: 'x402', cap: '1', perCall: '0.25', expiresAt: t + 1800 })
    expect(seenBeforeActivation.executionBudget).toMatchObject({ kind: 'x402', symbol: 'USDC', amount: '1', perCall: '0.25', grant: 'promised' })
    const prep = await board.budgetGrantPrepare({ address: creator.address }, { taskId, privyAccessToken: await privy.accessToken(await now()) })
    const { policyId, signerId } = prep as { policyId: string; signerId: string }
    const rule = privy.policies.get(policyId)?.rules.find((r) => r.name === `budget-${taskId}`)
    expect(rule?.conditions.map((c) => [c.field, c.value])).toEqual([
      ['chainId', '10143'], ['verifyingContract', usdc], ['value', '250000'], ['current_unix_timestamp', String(t + 1800)],
    ])
    privy.addSigner(signerId, policyId)
    expect(await board.budgetGrantConfirm({ address: creator.address }, { taskId })).toMatchObject({ status: 'live', kind: 'x402', perCall: '0.25', symbol: 'USDC' })

    // The creator holds testnet USDC (minted through its masterMinter on the fork).
    await rpcCall('anvil_setBalance', [minter, `0x${parseEther('10').toString(16)}`])
    await rpcCall('anvil_impersonateAccount', [minter])
    for (const data of [
      encodeFunctionData({ abi: usdcAbi, functionName: 'configureMinter', args: [minter, parseUnits('100', 6)] }),
      encodeFunctionData({ abi: usdcAbi, functionName: 'mint', args: [creator.address, parseUnits('5', 6)] }),
    ]) {
      const hash = (await rpcStrict('eth_sendTransaction', [{ from: minter, to: usdc, data }])) as Hex
      expect((await ctx().publicClient.waitForTransactionReceipt({ hash })).status).toBe('success')
    }

    // What an x402 client asks its signer to sign for a 0.1 USDC endpoint.
    const seller = privateKeyToAccount(generatePrivateKey()).address
    const payment = (over: Record<string, unknown> = {}, domain: Record<string, unknown> = {}) => ({
      domain: { name: 'USDC', version: '2', chainId: 10143, verifyingContract: usdc, ...domain },
      types: { TransferWithAuthorization: [] },
      primaryType: 'TransferWithAuthorization',
      message: { from: creator.address, to: seller, value: '100000', validAfter: '0', validBefore: String(t + 300), nonce: `0x${randomBytesHex()}`, ...over },
    })
    await expect(board.signBudgetX402({ address: stranger.address }, { taskId, typedData: payment() })).rejects.toThrow('activated worker')
    await expect(board.signBudgetX402({ address: worker.address }, { taskId, typedData: payment({ value: '300000' }) })).rejects.toThrow('per-payment cap')
    await expect(board.signBudgetX402({ address: worker.address }, { taskId, typedData: payment({}, { verifyingContract: seller }) })).rejects.toThrow('USDC')
    await expect(board.signBudgetX402({ address: worker.address }, { taskId, typedData: payment({ from: worker.address }) })).rejects.toThrow('creator')
    await expect(board.signBudgetX402({ address: worker.address }, { taskId, typedData: payment({ validBefore: String(t + 7200) }) })).rejects.toThrow('validBefore')
    await expect(board.spendBudget({ address: worker.address }, { taskId, to: seller, amount: '0.1' })).rejects.toThrow('sign_budget_x402')

    const p1 = payment()
    const signed = await board.signBudgetX402({ address: worker.address }, { taskId, typedData: p1, note: 'paid search' })
    await expect(board.signBudgetX402({ address: worker.address }, { taskId, typedData: p1 })).rejects.toThrow('nonce')
    // The facilitator settles it: anyone may submit the creator's authorization; the seller is paid from the creator.
    const { r, s: sv, v } = parseSignature(signed.signature)
    const a = signed.authorization
    const settle = await w(stranger).writeContract({
      address: usdc, abi: usdcAbi, functionName: 'transferWithAuthorization',
      args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce as Hex, Number(v), r, sv],
    })
    await ctx().publicClient.waitForTransactionReceipt({ hash: settle })
    expect(await ctx().publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: 'balanceOf', args: [seller] })).toBe(100000n)

    // A second authorization is signed but never used: reserved, then released once it expires.
    await board.signBudgetX402({ address: worker.address }, { taskId, typedData: payment({ value: '250000', validBefore: String(t + 120) }) })
    const mid = await board.getBudget({ address: creator.address }, { taskId })
    expect(mid).toMatchObject({ spent: '0.1', reserved: '0.25', remaining: '0.65' })
    expect(mid.spends[0]).toMatchObject({ status: 'confirmed', txHash: settle, amount: '0.1' })
    await rpcCall('evm_increaseTime', [200])
    await rpcCall('evm_mine', [])
    skew += 200
    const after = await board.getBudget({ address: creator.address }, { taskId })
    expect(after).toMatchObject({ spent: '0.1', reserved: '0', remaining: '0.9' })
    expect(after.spends.map((x) => x.status)).toEqual(['confirmed', 'failed'])
  }, 300_000)

  it('while the core is paused the board hands out no transaction and no spend', async () => {
    // OpenZeppelin PausableUpgradeable's ERC-7201 slot ("openzeppelin.storage.Pausable"); the admin pauses live.
    const slot = '0xcd5ed15c6e187e77e9aee88184c21f4f2182ab5827cb3b7e07fbedcd63f03300'
    const core = ctx().deployment.core
    const t = await now()
    const base = { title: 'x', brief: 'x', acceptanceCriteria: ['x'], token: 'mUSD', reward: '2', creatorBond: '1', workerBond: '1', mode: 'hire' as const, stack: 'demo' as const }
    const open = await board.createTask({ address: creator.address }, { ...base, deliveryDeadline: t + 3600 })
    await rpcCall('anvil_setStorageAt', [core, slot, `0x${'0'.repeat(63)}1`])
    skew += 20 // past the 15 s cache
    try {
      expect(await ctx().publicClient.readContract({ address: core, abi: sdk.coreAbi, functionName: 'paused' })).toBe(true)
      await expect(board.createTask({ address: creator.address }, { ...base, deliveryDeadline: t + 3600 })).rejects.toThrow('paused')
      await expect(board.publishTransactions({ address: creator.address }, { taskId: open.taskId })).rejects.toThrow('paused')
      await expect(board.settlementActions({}, { taskId: open.taskId })).rejects.toThrow('paused')
      const seen = await board.getTask({ address: creator.address }, { taskId: open.taskId })
      expect(seen.chain.paused).toBe(true)
    } finally {
      await rpcCall('anvil_setStorageAt', [core, slot, `0x${'0'.repeat(64)}`])
      skew += 20
    }
    expect(await board.paused('demo')).toBe(false)
  }, 180_000)
})
