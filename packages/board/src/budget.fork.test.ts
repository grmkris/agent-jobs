/**
 * Execution budget (ADR-0005) on a local anvil fork of Monad testnet: declared costs in quotes, the approved budget
 * frozen into the offer, and the grant record the board keeps. Nothing is sent to the real chain.
 *
 * Needs MONAD_TESTNET_RPC_URL and `anvil` on PATH; skipped otherwise.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@agent-jobs/sdk'
import { type Hex, parseEther, parseUnits } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Board, type BoardConfig, fromNodeSqlite, parseTerms } from './index.ts'

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

async function rpcCall(method: string, params: unknown[]) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return ((await res.json()) as { result: unknown }).result
}

const config = (): BoardConfig => ({
  network: NET,
  contexts: { main: sdk.context(NET, 'main', url), demo: ctx() },
  domain: 'board.test',
  uri: 'https://board.test',
  manifestBaseUrl: 'https://board.test/offers',
})
const now = async () => Number((await ctx().publicClient.getBlock()).timestamp)

fork('execution budget on a testnet fork', () => {
  const db = new DatabaseSync(':memory:')
  const board = new Board(fromNodeSqlite(db), config())
  const creator = privateKeyToAccount(generatePrivateKey())
  const worker = privateKeyToAccount(generatePrivateKey())
  const w = (a: typeof creator) => sdk.wallet(NET, a, url)
  let agentId = ''

  async function signIn(account: typeof creator) {
    const { message } = board.authChallenge({ address: account.address })
    return board.authLogin({ message, signature: await account.signMessage({ message }) })
  }

  beforeAll(async () => {
    anvil = spawn('anvil', ['--fork-url', rpc, '--port', String(PORT), '--silent'], { stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      const id = await rpcCall('eth_chainId', []).catch(() => undefined)
      if (id !== undefined) break
      await new Promise((r) => setTimeout(r, 500))
    }
    for (const a of [creator, worker]) await rpcCall('anvil_setBalance', [a.address, `0x${parseEther('100').toString(16)}`])
    agentId = (await sdk.registerAgent(ctx(), w(worker), 'https://example.test/agent.json')).toString()
    await signIn(creator)
    await signIn(worker)
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
})
