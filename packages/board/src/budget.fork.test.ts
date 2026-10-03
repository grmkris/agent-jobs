/**
 * Execution budget (ADR-0009) on a local anvil fork of Monad testnet, against the real MetaMask Delegation Framework
 * deployed there: declared costs in quotes, the approved budget frozen into the offer, and the grant/draw lifecycle
 * with the creator's wallet upgraded to the DeleGator (EIP-7702). The chain's enforcers are exercised directly:
 * over-cap, wrong recipient, wrong redeemer, a second call, expiry and a disabled delegation all revert on-chain,
 * whatever the board says. Nothing is sent to the real chain.
 *
 * Needs MONAD_TESTNET_RPC_URL and `anvil` on PATH; skipped otherwise.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@agent-jobs/sdk'
import { localTestPort } from '../../sdk/test/fork-port.ts'
import { type AbiFunction, type Address, type Hex, encodeFunctionData, erc20Abi, parseAbiItem, parseEther, parseUnits, toFunctionSelector } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Board, type BoardConfig, type BudgetInput, type Delegation, advanceExecution, fromNodeSqlite, parseTerms, redeemCalldata } from './index.ts'

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
let url = ''
const NET = 'monad-testnet' as const
const legacyDemo = sdk.deployment(NET).legacyStacks['demo-v2']!

let anvil: ChildProcess | undefined
const ctx = () => sdk.contextFor(NET, legacyDemo, url)
const balance = (token: Address, of: Address) => ctx().publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [of] })

async function rpcCall(method: string, params: unknown[]) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return ((await res.json()) as { result: unknown }).result
}

/** Seconds the fork's clock was moved ahead; the board's clock follows it, as wall clock and chain agree live. */
let skew = 0

/** The board's relay: it sends rulings and, here, the upgrade of a wallet that can only sign an authorization. */
const relayer = privateKeyToAccount(generatePrivateKey())

const config = (): BoardConfig => ({
  network: NET,
  relay: { account: relayer, rpcUrl: url },
  contexts: { main: sdk.context(NET, 'main', url), demo: ctx() },
  domain: 'board.test',
  uri: 'https://board.test',
  manifestBaseUrl: 'https://board.test/offers',
  now: () => Math.floor(Date.now() / 1000) + skew,
})
const now = async () => Number((await ctx().publicClient.getBlock()).timestamp)

async function advanceClock(seconds: number) {
  await rpcCall('evm_increaseTime', [seconds])
  await rpcCall('evm_mine', [])
  skew += seconds
}

fork('execution budget on a testnet fork', () => {
  const db = new DatabaseSync(':memory:')
  const creator = privateKeyToAccount(generatePrivateKey())
  const worker = privateKeyToAccount(generatePrivateKey())
  const stranger = privateKeyToAccount(generatePrivateKey())
  let board: Board
  const w = (a: typeof creator) => sdk.wallet(NET, a, url)
  let agentId = ''

  async function signIn(account: typeof creator) {
    const { message } = board.authChallenge({ address: account.address })
    return board.authLogin({ message, signature: await account.signMessage({ message }) })
  }

  /** Sends one transaction with a fixed gas limit, so a revert is mined (and reportable) instead of failing estimation. */
  async function send(from: typeof creator, to: Address, data: Hex) {
    const hash = await w(from).sendTransaction({ to, data, gas: 1_500_000n })
    return ctx().publicClient.waitForTransactionReceipt({ hash })
  }

  /** The creator's wallet points its code at the framework's DeleGator: one type-4 transaction to itself. */
  async function upgrade(account: typeof creator) {
    const wallet = w(account)
    const authorization = await wallet.signAuthorization({ account, contractAddress: ctx().deployment.delegation.delegator, executor: 'self' })
    const hash = await wallet.sendTransaction({ to: account.address, data: '0x', authorizationList: [authorization] })
    expect((await ctx().publicClient.waitForTransactionReceipt({ hash })).status).toBe('success')
  }

  /** Prepare, sign, confirm: the budget goes live. */
  async function grant(taskId: string) {
    const prep = await board.budgetGrantPrepare({ address: creator.address }, { taskId })
    expect(prep.upgrade).toBeNull()
    return board.budgetGrantConfirm({ address: creator.address }, { taskId, signature: await sdk.signTypedDataJson(w(creator), prep.sign.typedData) })
  }

  /** The signed delegation, as get_budget hands it to the worker for a redemption without the board. */
  async function signedDelegation(taskId: string): Promise<Delegation> {
    const b = await board.getBudget({ address: worker.address }, { taskId })
    const d = b.delegation?.delegation as Omit<Delegation, 'salt'> & { salt: string }
    return { ...d, salt: BigInt(d.salt) }
  }

  beforeAll(async () => {
    const port = await localTestPort()
    url = `http://127.0.0.1:${port}`
    board = new Board(fromNodeSqlite(db), config())
    anvil = spawn('anvil', ['--fork-url', rpc, '--port', String(port), '--silent'], { stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      const id = await rpcCall('eth_chainId', []).catch(() => undefined)
      if (id !== undefined) break
      await new Promise((r) => setTimeout(r, 500))
    }
    for (const a of [creator, worker, stranger, relayer]) await rpcCall('anvil_setBalance', [a.address, `0x${parseEther('100').toString(16)}`])
    const c = ctx()
    // mUSD and mEUR: later reward tokens (e.g. $CHOMP) are real tokens with no faucet
    for (const token of [c.stack.factory, ...c.deployment.rewardTokens.slice(0, 2)]) await sdk.faucet(c, w(creator), token)
    await sdk.faucet(c, w(worker), c.stack.factory)
    agentId = (await sdk.registerAgent(c, w(worker), 'https://example.test/agent.json')).toString()
    await signIn(creator)
    await signIn(worker)
    await signIn(stranger)
  }, 120_000)

  afterAll(() => {
    anvil?.kill()
  })

  it('declared costs travel with a quote, change its hash, and the pick freezes the approved advance into the offer', async () => {
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
    const listed = await board.listQuotes({ address: creator.address }, { requestId: req.requestId })
    const q = listed.quotes[0]
    expect(q?.expectedCosts).toMatchObject({ token: mEUR, symbol: 'mEUR', amount: '2', note: 'model calls' })

    // The creator approves less than asked; the token defaults to the declared costs' token.
    const picked = await board.pickQuote({ address: creator.address }, { requestId: req.requestId, quoteId: q?.quoteId as string, executionBudget: { kind: 'advance', cap: '1.5' } })
    const terms = parseTerms(picked.manifest as string)
    expect(terms.token.toLowerCase()).toBe(mUSD.toLowerCase())
    expect(terms.executionBudget).toEqual({ kind: 'advance', token: mEUR, cap: parseUnits('1.5', 6), expiresAt: t + 3600 })
    const index = board.taskIndex({}).find((x) => x.taskId === picked.taskId)
    expect(index?.executionBudget).toEqual({ kind: 'advance', token: mEUR, cap: parseUnits('1.5', 6).toString(), expiresAt: t + 3600 })
    const seen = await board.getTask({ address: worker.address }, { taskId: picked.taskId })
    expect(seen.executionBudget).toMatchObject({ kind: 'advance', symbol: 'mEUR', amount: '1.5', expiresAt: t + 3600, grant: 'promised' })
  }, 180_000)

  it('refuses a budget on a contest, one outliving the delivery deadline, a token that is not an ERC-20, and a grant before activation', async () => {
    const t = await now()
    const base = { title: 'x', brief: 'x', acceptanceCriteria: ['x'], token: 'mUSD', reward: '2', creatorBond: '1', stack: 'demo' as const }
    await expect(
      board.createTask({ address: creator.address }, {
        ...base, workerBond: '0', mode: 'contest', deliveryDeadline: t + 3600, selectionDeadline: t + 600, executionBudget: { kind: 'advance', token: 'mUSD', cap: '1' },
      }),
    ).rejects.toThrow('Only a hire')
    await expect(
      board.createTask({ address: creator.address }, {
        ...base, workerBond: '1', mode: 'hire', deliveryDeadline: t + 3600, executionBudget: { kind: 'advance', token: 'mUSD', cap: '1', expiresAt: t + 3601 },
      }),
    ).rejects.toThrow('expires')
    await expect(
      board.createTask({ address: creator.address }, {
        ...base, workerBond: '1', mode: 'hire', deliveryDeadline: t + 3600, executionBudget: { kind: 'advance', token: stranger.address, cap: '1' },
      }),
    ).rejects.toThrow('not an ERC-20')
    // Any ERC-20 works, not only reward tokens: FACTORY is one.
    const open = await board.createTask({ address: creator.address }, {
      ...base, workerBond: '1', mode: 'hire', deliveryDeadline: t + 3600, executionBudget: { kind: 'advance', token: ctx().stack.factory, cap: '1' },
    })
    await expect(board.budgetGrantPrepare({ address: creator.address }, { taskId: open.taskId })).rejects.toThrow('once the worker has activated')
  }, 180_000)

  /** A hire with a budget, published, the worker selected and activated. */
  async function activeHire(budget: BudgetInput) {
    const c = ctx()
    const t = await now()
    const created = await board.createTask({ address: creator.address }, {
      title: 'Budgeted hire', brief: 'Fork test.', acceptanceCriteria: ['x'], token: 'mUSD', reward: '2', creatorBond: '1', workerBond: '1',
      deliveryDeadline: t + 3600, mode: 'hire', stack: 'demo', executionBudget: budget,
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

  it('an advance: grant after upgrade, draws within the cap, the chain refusing everything else, a direct redemption, revoke', async () => {
    const [, mEUR] = ctx().deployment.rewardTokens as [Hex, Hex]
    const manager = ctx().deployment.delegation.manager
    const t = await now()
    const { taskId, seenBeforeActivation } = await activeHire({ kind: 'advance', token: 'mEUR', cap: '1.5', expiresAt: t + 1800 })
    // The worker sees the budget, and that it is only promised, before it commits.
    expect(seenBeforeActivation.executionBudget).toMatchObject({ kind: 'advance', symbol: 'mEUR', amount: '1.5', grant: 'promised' })
    await expect(board.spendBudget({ address: worker.address }, { taskId, amount: '0.1' })).rejects.toThrow('not granted')
    await expect(board.budgetGrantPrepare({ address: worker.address }, { taskId })).rejects.toThrow('only the creator')

    // Grant: the wallet is not a DeleGator yet, so the board asks for the upgrade and refuses to confirm without it.
    const prep = await board.budgetGrantPrepare({ address: creator.address }, { taskId })
    expect(prep.upgrade?.delegator).toBe(ctx().deployment.delegation.delegator)
    const signature = await sdk.signTypedDataJson(w(creator), prep.sign.typedData)
    await expect(board.budgetGrantConfirm({ address: creator.address }, { taskId, signature })).rejects.toThrow('DeleGator')
    await upgrade(creator)
    const wrong = await sdk.signTypedDataJson(w(worker), prep.sign.typedData)
    await expect(board.budgetGrantConfirm({ address: creator.address }, { taskId, signature: wrong })).rejects.toThrow('not the creator')
    expect(await board.budgetGrantConfirm({ address: creator.address }, { taskId, signature })).toMatchObject({ status: 'live', kind: 'advance', cap: '1.5', drawn: '0' })

    // Only the worker, only within the cap.
    await expect(board.spendBudget({ address: stranger.address }, { taskId, amount: '0.1' })).rejects.toThrow('activated worker')
    await expect(board.spendBudget({ address: worker.address }, { taskId, amount: '1.6' })).rejects.toThrow('over the budget: 1.5 left')

    // A draw: the worker sends the redemption from its own wallet; the creator's tokens move to the worker.
    const before = [await balance(mEUR, creator.address), await balance(mEUR, worker.address)] as const
    const first = await board.spendBudget({ address: worker.address }, { taskId, amount: '1', note: 'model calls' })
    expect(first.transactions).toHaveLength(1)
    expect(first.transactions[0]?.to).toBe(manager)
    const [hash] = await sdk.sendAll(w(worker), ctx().publicClient, first.transactions)
    await board.reportTransaction({ address: worker.address }, { taskId, txHash: hash as string })
    expect(await balance(mEUR, creator.address)).toBe(before[0] - 1_000_000n)
    expect(await balance(mEUR, worker.address)).toBe(before[1] + 1_000_000n)
    let b = await board.getBudget({ address: creator.address }, { taskId })
    expect(b).toMatchObject({ drawn: '1', remaining: '0.5' })
    expect(b.draws[0]).toMatchObject({ amount: '1', status: 'confirmed', note: 'model calls' })

    // The enforcers hold whatever the board says: another recipient, another redeemer, more than is left.
    const d = await signedDelegation(taskId)
    expect((await send(worker, manager, redeemCalldata(d, advanceExecution(mEUR, stranger.address, 100_000n)))).status).toBe('reverted')
    expect((await send(stranger, manager, redeemCalldata(d, advanceExecution(mEUR, stranger.address, 100_000n)))).status).toBe('reverted')
    expect((await send(worker, manager, redeemCalldata(d, advanceExecution(mEUR, worker.address, 600_000n)))).status).toBe('reverted')

    // Two draws prepared together each fit alone; the chain lets only what fits through, and the failure is recorded.
    const a1 = await board.spendBudget({ address: worker.address }, { taskId, amount: '0.3' })
    const a2 = await board.spendBudget({ address: worker.address }, { taskId, amount: '0.3' })
    // A reverted transaction that is not one of them, reported on this task, leaves both prepared.
    const unrelated = await send(worker, mEUR, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [stranger.address, 10n ** 30n] }))
    expect(unrelated.status).toBe('reverted')
    await board.reportTransaction({ address: worker.address }, { taskId, txHash: unrelated.transactionHash })
    expect((await board.getBudget({ address: worker.address }, { taskId })).draws.map((x) => x.status)).toEqual(['confirmed', 'prepared', 'prepared'])
    const r1 = await send(worker, manager, a1.transactions[0]?.data as Hex)
    await board.reportTransaction({ address: worker.address }, { taskId, txHash: r1.transactionHash })
    const r2 = await send(worker, manager, a2.transactions[0]?.data as Hex)
    expect([r1.status, r2.status]).toEqual(['success', 'reverted'])
    await board.reportTransaction({ address: worker.address }, { taskId, txHash: r2.transactionHash })

    // A redemption without the board: the worker holds the signed delegation; reporting it mirrors the draw.
    const direct = await send(worker, manager, redeemCalldata(d, advanceExecution(mEUR, worker.address, 100_000n)))
    expect(direct.status).toBe('success')
    await board.reportTransaction({ address: worker.address }, { taskId, txHash: direct.transactionHash })
    b = await board.getBudget({ address: worker.address }, { taskId })
    expect(b).toMatchObject({ drawn: '1.4', remaining: '0.1' })
    expect(b.draws.map((x) => [x.amount, x.status])).toEqual([['1', 'confirmed'], ['0.3', 'confirmed'], ['0.3', 'failed'], ['0.1', 'confirmed']])

    // Paused core: the board prepares nothing.
    const slot = '0xcd5ed15c6e187e77e9aee88184c21f4f2182ab5827cb3b7e07fbedcd63f03300'
    await rpcCall('anvil_setStorageAt', [ctx().deployment.core, slot, `0x${'0'.repeat(63)}1`])
    try {
      await expect(board.spendBudget({ address: worker.address }, { taskId, amount: '0.05' })).rejects.toThrow('paused')
    } finally {
      await rpcCall('anvil_setStorageAt', [ctx().deployment.core, slot, `0x${'0'.repeat(64)}`])
    }

    // Revoke: the board stops at once; the disable transaction from the creator stops direct redemptions too.
    const revoked = await board.revokeBudget({ address: creator.address }, { taskId })
    expect(revoked).toMatchObject({ status: 'revoked', endedReason: 'revoked by the creator' })
    await expect(board.spendBudget({ address: worker.address }, { taskId, amount: '0.05' })).rejects.toThrow('revoked')
    await sdk.sendAll(w(creator), ctx().publicClient, revoked.transactions)
    expect((await send(worker, manager, redeemCalldata(d, advanceExecution(mEUR, worker.address, 50_000n)))).status).toBe('reverted')
    expect((await board.revokeBudget({ address: creator.address }, { taskId })).transactions).toEqual([])
  }, 300_000)

  it('an advance expires on-chain at its expiry, and the board ends it', async () => {
    const [, mEUR] = ctx().deployment.rewardTokens as [Hex, Hex]
    const t = await now()
    const { taskId } = await activeHire({ kind: 'advance', token: 'mEUR', cap: '1', expiresAt: t + 900 })
    await grant(taskId)
    const d = await signedDelegation(taskId)
    await advanceClock(1000)
    await expect(board.spendBudget({ address: worker.address }, { taskId, amount: '0.1' })).rejects.toThrow('expired')
    expect((await send(worker, ctx().deployment.delegation.manager, redeemCalldata(d, advanceExecution(mEUR, worker.address, 100_000n)))).status).toBe('reverted')
    expect(await board.getBudget({ address: creator.address }, { taskId })).toMatchObject({ status: 'ended', endedReason: 'expired' })
  }, 300_000)

  it('a call budget: one call from the creator’s account (faucet on mUSD), then never again', async () => {
    const [mUSD] = ctx().deployment.rewardTokens as [Hex]
    const t = await now()
    const { taskId } = await activeHire({ kind: 'call', target: mUSD, function: 'function faucet()', cap: '0', expiresAt: t + 1800 })
    await grant(taskId)
    const data = toFunctionSelector('function faucet()')
    await expect(board.spendBudget({ address: worker.address }, { taskId, amount: '1' })).rejects.toThrow('spend_budget_call')
    await expect(board.spendBudgetCall({ address: worker.address }, { taskId, data: '0xa9059cbb00' })).rejects.toThrow('selector')
    await expect(board.spendBudgetCall({ address: worker.address }, { taskId, data, value: '1' })).rejects.toThrow('at most 0')
    const before = await balance(mUSD, creator.address)
    const call = await board.spendBudgetCall({ address: worker.address }, { taskId, data, note: 'faucet for the creator' })
    const [hash] = await sdk.sendAll(w(worker), ctx().publicClient, call.transactions)
    await board.reportTransaction({ address: worker.address }, { taskId, txHash: hash as string })
    // The creator's account made the call, so the faucet minted to the creator.
    expect(await balance(mUSD, creator.address)).toBeGreaterThan(before)
    expect(await board.getBudget({ address: creator.address }, { taskId })).toMatchObject({ calls: { made: 1, allowed: 1 } })
    await expect(board.spendBudgetCall({ address: worker.address }, { taskId, data })).rejects.toThrow('already made')
    const d = await signedDelegation(taskId)
    expect((await send(worker, ctx().deployment.delegation.manager, redeemCalldata(d, { target: mUSD, value: 0n, callData: data }))).status).toBe('reverted')
  }, 300_000)

  it('a call budget launches a token on nad.fun: the creator is msg.sender, the value is capped', async () => {
    // nad.fun's bonding-curve router on Monad testnet; `create` costs a 10 MON deploy fee.
    const router = '0x865054F0F6A288adaAc30261731361EA7E908003' as const
    const fn = 'function create((string name,string symbol,string tokenURI,uint256 amountOut,bytes32 salt,uint8 actionId) params) payable'
    const t = await now()
    const { taskId, seenBeforeActivation } = await activeHire({ kind: 'call', target: router, function: fn, cap: '12', expiresAt: t + 1800 })
    expect(seenBeforeActivation.executionBudget).toMatchObject({ kind: 'call', target: router, amount: '12', symbol: 'MON', grant: 'promised' })
    await grant(taskId)
    const salt = `0x${'ab'.repeat(32)}` as Hex
    const data = encodeFunctionData({ abi: [parseAbiItem(fn) as AbiFunction], args: [{ name: 'Chomp', symbol: 'CHOMP', tokenURI: 'https://example.test/chomp.json', amountOut: 0n, salt, actionId: 1 }] })
    await expect(board.spendBudgetCall({ address: worker.address }, { taskId, data, value: '13' })).rejects.toThrow('at most 12')
    const before = await ctx().publicClient.getBalance({ address: creator.address })
    const call = await board.spendBudgetCall({ address: worker.address }, { taskId, data, value: '10', note: 'nad.fun deploy fee' })
    const [hash] = await sdk.sendAll(w(worker), ctx().publicClient, call.transactions)
    const receipt = await ctx().publicClient.getTransactionReceipt({ hash: hash as Hex })
    await board.reportTransaction({ address: worker.address }, { taskId, txHash: hash as string })
    // The worker sent the transaction and paid its gas; the creator's account made the call and paid the fee.
    expect(receipt.from.toLowerCase()).toBe(worker.address.toLowerCase())
    const creatorWord = creator.address.slice(2).toLowerCase()
    expect(receipt.logs.some((l) => (l.topics as readonly string[]).some((x) => x.toLowerCase().endsWith(creatorWord)) || l.data.toLowerCase().includes(creatorWord))).toBe(true)
    expect(before - (await ctx().publicClient.getBalance({ address: creator.address }))).toBe(parseEther('10'))
    expect(await board.getBudget({ address: creator.address }, { taskId })).toMatchObject({ drawn: '10', remaining: '2', calls: { made: 1, allowed: 1 } })
  }, 300_000)

  it('a wallet that can only sign an authorization is upgraded by the relay, and only with its own, current one', async () => {
    const key = generatePrivateKey()
    const signer = privateKeyToAccount(key)
    await signIn(signer)
    const me = { address: signer.address }
    const delegator = ctx().deployment.delegation.delegator
    const sign = (contractAddress: Address, nonce: number, by = signer) => by.signAuthorization({ contractAddress, chainId: ctx().deployment.chainId, nonce })
    const json = (a: Awaited<ReturnType<typeof sign>>) => ({ address: a.address, chainId: a.chainId, nonce: a.nonce, r: a.r, s: a.s, yParity: a.yParity })
    await expect(board.upgradeAccount(me, { authorization: json(await sign(ctx().deployment.rewardTokens[0] as Address, 0)) })).rejects.toThrow('must name the DeleGator')
    await expect(board.upgradeAccount(me, { authorization: json(await sign(delegator, 0, stranger)) })).rejects.toThrow('not signed by your account')
    await expect(board.upgradeAccount(me, { authorization: json(await sign(delegator, 5)) })).rejects.toThrow('sign it again')
    // The wallet holds no MON and sends nothing: the relay pays. The authorization as `cast wallet sign-auth` prints it.
    const rlp = execFileSync('cast', ['wallet', 'sign-auth', delegator, '--nonce', '0', '--chain', String(ctx().deployment.chainId), '--private-key', key], { encoding: 'utf8' }).trim()
    const up = await board.upgradeAccount(me, { authorization: rlp })
    expect(up.txHash).toMatch(/^0x/)
    expect((await sdk.delegationOf(ctx().publicClient, signer.address))?.toLowerCase()).toBe(delegator.toLowerCase())
    expect(await ctx().publicClient.getBalance({ address: signer.address })).toBe(0n)
    expect(await board.upgradeAccount(me, { authorization: json(await sign(delegator, 1)) })).toMatchObject({ upgraded: true, txHash: null })
  }, 120_000)
})
