/**
 * ADR-0010 on a local anvil fork of Monad testnet: a reward in a token nobody listed, through the board, on the pair
 * whose Holding is safe with any ERC-20, and refused on a legacy pair that predates it. The reward is the real
 * FACTORY v2, funded from the recorded ecosystem holder only on the local fork; it has no faucet.
 *
 * Needs MONAD_TESTNET_RPC_URL and `anvil` on PATH; skipped otherwise.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex, encodeFunctionData, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Board, type BoardConfig, fromNodeSqlite } from './index.ts'

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
const PORT = 8663
const url = `http://127.0.0.1:${PORT}`
const NET = 'monad-testnet' as const
const legacyDemo = sdk.deployment(NET).legacyStacks['demo-v2']!

let anvil: ChildProcess | undefined
const ctx = (stack: 'main' | 'demo' = 'main') => stack === 'main' ? sdk.context(NET, stack, url) : sdk.contextFor(NET, legacyDemo, url)

const token = () => ctx().stack.factory
const config = (): BoardConfig => ({
  network: NET,
  contexts: { main: ctx('main'), demo: ctx('demo') },
  domain: 'board.test',
  uri: 'https://board.test',
  manifestBaseUrl: 'https://board.test/offers',
  // The submission check is advisory; nothing here should leave the machine.
  fetch: async () => new Response('delivered'),
})

const offer = async (stack: sdk.StackName) => ({
  title: 'Paid in a token nobody listed',
  brief: 'Fork test.',
  acceptanceCriteria: ['x'],
  deliverable: { accepts: ['url' as const], target: 'A link' },
  token: token(),
  reward: '3',
  creatorBond: '0',
  workerBond: '0',
  deliveryDeadline: Number((await ctx().publicClient.getBlock()).timestamp) + 3600,
  mode: 'hire' as const,
  stack,
})

async function rpcCall(method: string, params: unknown[]) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return ((await res.json()) as { result: unknown }).result
}

fork('permissionless reward tokens on a testnet fork (ADR-0010)', () => {
  const db = new DatabaseSync(':memory:')
  const creator = privateKeyToAccount(generatePrivateKey())
  const worker = privateKeyToAccount(generatePrivateKey())
  const w = (a: typeof creator) => sdk.wallet(NET, a, url)
  let board: Board
  let agentId = ''

  async function signIn(account: typeof creator) {
    const { message } = board.authChallenge({ address: account.address })
    return board.authLogin({ message, signature: await account.signMessage({ message }) })
  }

  beforeAll(async () => {
    board = new Board(fromNodeSqlite(db), config())
    anvil = spawn('anvil', ['--fork-url', rpc, '--port', String(PORT), '--silent'], { stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      const id = await rpcCall('eth_chainId', []).catch(() => undefined)
      if (id !== undefined) break
      await new Promise((r) => setTimeout(r, 500))
    }
    for (const a of [creator, worker]) await rpcCall('anvil_setBalance', [a.address, `0x${parseEther('100').toString(16)}`])
    // Impersonation is confined to this local anvil URL. The promoted v2 token has no faucet.
    const c = ctx(), ecosystem = c.deployment.admin
    await rpcCall('anvil_impersonateAccount', [ecosystem])
    await rpcCall('anvil_setBalance', [ecosystem, `0x${parseEther('100').toString(16)}`])
    try {
      for (const a of [creator, worker]) {
        const hash = await rpcCall('eth_sendTransaction', [{ from: ecosystem, to: token(),
          data: encodeFunctionData({ abi: sdk.factoryTokenAbi, functionName: 'transfer', args: [a.address, parseEther('100')] }) }]) as Hex
        expect((await c.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success')
      }
    } finally { await rpcCall('anvil_stopImpersonatingAccount', [ecosystem]) }
    agentId = (await sdk.registerAgent(ctx(), w(worker), 'https://example.test/agent.json')).toString()
    await signIn(creator)
    await signIn(worker)
  }, 120_000)

  afterAll(() => {
    anvil?.kill()
  })

  it('the config marks the redeployed main pair, and only it, as safe with any ERC-20', () => {
    const d = ctx().deployment
    expect(d.stacks.main?.openTokens).toBe(true)
    expect(d.legacyStacks['demo-v2']?.openTokens).toBe(false)
    expect(d.rewardTokens.map((t) => t.toLowerCase())).not.toContain(token().toLowerCase())
  })

  it('a pair that predates open tokens refuses an unlisted token; a symbol nobody lists is refused too', async () => {
    await expect(board.createTask({ address: creator.address }, await offer('demo'))).rejects.toThrow(/predates open tokens/)
    await expect(board.createTask({ address: creator.address }, { ...(await offer('main')), token: 'DOGE' })).rejects.toThrow(/by its address/)
    await expect(board.createTask({ address: creator.address }, { ...(await offer('main')), token: '0x000000000000000000000000000000000000dEaD' })).rejects.toThrow(/not an ERC-20/)
  })

  it('an unlisted ERC-20 goes from publish to payout on the main pair', async () => {
    const c = ctx()
    const created = await board.createTask({ address: creator.address }, await offer('main'))
    const published = await sdk.sendAll(w(creator), c.publicClient, created.transactions)
    await board.reportTransaction({ address: creator.address }, { taskId: created.taskId, txHash: published.at(-1) as string })
    const listed = await board.getTask({ address: creator.address }, { taskId: created.taskId })
    expect(listed.chain.status).toBe('open')
    expect(listed.chain.listingMatchesOffer).toBe(true)

    const app = await board.apply({ address: worker.address }, { taskId: created.taskId, agentId, note: 'I accept FACTORY' })
    const sel = await board.selectWorker({ address: creator.address }, { taskId: created.taskId, applicationId: app.applicationId })
    await board.submitSelection({ address: creator.address }, { taskId: created.taskId, nonce: sel.nonce, signature: await sdk.signTypedDataJson(w(creator), sel.sign.typedData) })
    const prep = await board.prepareActivation({ address: worker.address }, { taskId: created.taskId })
    await sdk.sendAll(w(worker), c.publicClient, prep.transactions)
    const act = await board.buildActivation({ address: worker.address }, { taskId: created.taskId, budgetSignature: await sdk.signTypedDataJson(w(worker), prep.sign.typedData) })
    await sdk.sendAll(w(worker), c.publicClient, act.transactions)

    const sub = await board.submitWork({ address: worker.address }, { taskId: created.taskId, deliverable: { kind: 'url', url: 'https://example.test/done' } })
    const [submitted] = await sdk.sendAll(w(worker), c.publicClient, sub.transactions)
    await board.reportTransaction({ address: worker.address }, { taskId: created.taskId, txHash: submitted as string })

    const before = await sdk.balanceOf(c, token() as Address, worker.address)
    const [, , net] = await sdk.quoteActivation(c, BigInt(listed.jobId!), worker.address)
    const approve = await board.approveWork({ address: creator.address }, { taskId: created.taskId })
    await sdk.sendAll(w(creator), c.publicClient, approve.transactions)
    expect((await sdk.balanceOf(c, token() as Address, worker.address)) - before).toBe(net)
    const settlement = await board.settlementActions({}, { taskId: created.taskId })
    await sdk.sendAll(w(worker), c.publicClient, settlement.transactions)
    expect((await board.getTask({ address: creator.address }, { taskId: created.taskId })).chain.status).toBe('completed')
  }, 240_000)
})
