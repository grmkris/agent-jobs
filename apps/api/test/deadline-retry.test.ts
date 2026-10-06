/** Relative deadlines through the real tools and Board: a retry echoes what was saved, and budgets freeze as integers. */
import { DatabaseSync } from 'node:sqlite'
import { Board, fromNodeSqlite } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { tools } from '../src/tools.ts'

const creator = '0x1111111111111111111111111111111111111111' as const
const worker = '0x2222222222222222222222222222222222222222' as const
const T = 1_791_000_000
const databases: DatabaseSync[] = []
let boardNow = T
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T * 1000); boardNow = T })
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) db.close() })

function fixture() {
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const read = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'paused') return false
    if (functionName === 'decimals') return 0
    if (functionName === 'symbol') return 'mUSD'
    if (functionName === 'getAgentWallet') return worker
    if (functionName === 'allowance') return 0n
    if (functionName === 'margin') return 120
    if (functionName === 'MIN_REVIEW_WINDOW' || functionName === 'MIN_DISPUTE_WINDOW') return 120
    if (functionName === 'MIN_ARBITRATION_WINDOW') return 300
    if (functionName.startsWith('MAX_')) return sdk.MAX_SIDEQUEST_WINDOW
    throw new Error(`unexpected chain read: ${functionName}`)
  })
  const client = { ...base.publicClient, readContract: read, getBlockNumber: vi.fn(async () => 100n) }
  const ctx = { ...base, stack: { ...base.stack, kind: 'sidequest-v1' }, publicClient: client } as unknown as sdk.Ctx
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const board = new Board(fromNodeSqlite(db), { network: 'monad-testnet', contexts: { main: ctx }, domain: 'deadline.test', uri: 'https://deadline.test', manifestBaseUrl: 'https://deadline.test/offers', now: () => boardNow })
  const run = (tool: string, args: Record<string, unknown>, address: `0x${string}` = creator) =>
    tools[tool]!.run(board, { address }, args, { network: 'monad-testnet', mcpSession: undefined }) as Promise<Record<string, unknown>>
  const token = base.deployment.rewardTokens[0]!
  const offer = { title: 'Offer', brief: 'Brief', acceptanceCriteria: ['works'], creatorBond: '0', workerBond: '0',
    windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 }, arbitrator: '0x4444444444444444444444444444444444444444' }
  return { board, run, token, offer }
}

const later = () => { vi.setSystemTime((T + 3600) * 1000); boardNow = T + 3600 }

it('a request_quotes retry under a moved clock echoes the saved deadlines, not its own resolution', async () => {
  const f = fixture()
  const args = { ...f.offer, tokens: [f.token], deliveryDeadline: '3d', quoteDeadline: '2d', idempotencyKey: 'rq' }
  const first = await f.run('request_quotes', args)
  expect(first).toMatchObject({ deliveryDeadline: T + 3 * 86_400, quoteDeadline: T + 2 * 86_400, deadlines: { deliveryDeadline: T + 3 * 86_400, quoteDeadline: T + 2 * 86_400 } })
  later()
  expect(await f.run('request_quotes', args)).toEqual(first)
})

it('a create_task retry under a moved clock returns the original terms and their deadlines', async () => {
  const f = fixture()
  const args = { ...f.offer, token: f.token, reward: '1', mode: 'hire', deliveryDeadline: '3d', idempotencyKey: 'ct',
    executionBudget: { kind: 'advance', token: f.token, cap: '1', expiresAt: '2d' } }
  const first = await f.run('create_task', args)
  expect(first.deadlines).toEqual({ deliveryDeadline: T + 3 * 86_400, budgetExpiresAt: T + 2 * 86_400 })
  later()
  const retry = await f.run('create_task', args)
  expect(retry).toEqual(first)
})

it('pick_quote freezes a relative or ISO budget expiry as integer seconds the delegation can use', async () => {
  for (const [key, expiresAt, expected] of [['relative', '2d', T + 2 * 86_400], ['iso', '2026-10-07T00:00:00Z', Date.UTC(2026, 9, 7) / 1000]] as const) {
    const f = fixture()
    const request = await f.run('request_quotes', { ...f.offer, tokens: [f.token], deliveryDeadline: '5d', quoteDeadline: '1d' })
    const quote = await f.board.submitQuote({ address: worker }, { requestId: request.requestId as string, agentId: '7', token: f.token, amount: '1' })
    const picked = await f.run('pick_quote', { requestId: request.requestId, quoteId: quote.quoteId, idempotencyKey: `pick-${key}`,
      executionBudget: { kind: 'advance', token: f.token, cap: '1', expiresAt } })
    const terms = JSON.parse(picked.manifest as string) as { executionBudget: { expiresAt: unknown } }
    expect(terms.executionBudget.expiresAt).toBe(expected)
    expect(BigInt(terms.executionBudget.expiresAt as number)).toBe(BigInt(expected))
    expect(picked.deadlines).toMatchObject({ budgetExpiresAt: expected })
  }
})

it('the board refuses a budget expiry that is not integer seconds, whatever the caller', async () => {
  const f = fixture()
  await expect(f.board.createTask({ address: creator }, { ...f.offer, token: f.token, reward: '1', mode: 'hire', deliveryDeadline: T + 86_400,
    executionBudget: { kind: 'advance', token: f.token, cap: '1', expiresAt: '3d' as never } })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('expiresAt') })
})
