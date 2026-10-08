/** Real board storage and preparations; promotion retires the original Holding without erasing cached evidence. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { Board } from './service.ts'
import { fromNodeSqlite, type SqlValue } from './store.ts'

const creator = '0x1111111111111111111111111111111111111111' as const
const worker = '0x2222222222222222222222222222222222222222' as const
const retired = '0x3333333333333333333333333333333333333333' as const
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

async function fixture(kind: sdk.StackKind) {
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const policyReads: Record<string, bigint | number | string> = {
    minimumCreatorBond: 10n ** 18n,
    unfilledForfeitBps: 2500,
    CANCEL_GRACE: 600,
    treasury: creator,
    UNSTAKE_DELAY: 259200,
  }
  const read = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName in policyReads) return policyReads[functionName]
    if (functionName === 'paused') return false
    if (functionName === 'decimals') return 0
    if (functionName === 'symbol') return 'mUSD'
    if (functionName === 'getAgentWallet') return worker
    if (functionName === 'allowance') return 0n
    if (functionName === 'margin') return 120
    if (
      functionName === 'MIN_REVIEW_WINDOW' ||
      functionName === 'MIN_DISPUTE_WINDOW' ||
      functionName === 'reviewWindow' ||
      functionName === 'disputeWindow' ||
      functionName === 'settlementWindow'
    )
      return 120
    if (functionName === 'MIN_ARBITRATION_WINDOW' || functionName === 'arbitrationWindow') return 300
    if (functionName.startsWith('MAX_')) return sdk.MAX_SIDEQUEST_WINDOW
    throw new Error(`unexpected chain read: ${functionName}`)
  })
  const blockNumber = vi.fn(async () => 100n)
  // SAFETY: preparation uses only the block timestamp in this partial RPC fixture.
  const getBlock = vi.fn().mockResolvedValue({ timestamp: 1000n })
  const client = { ...base.publicClient, readContract: read, getBlockNumber: blockNumber, getBlock }
  const oldPair: sdk.Stack = { ...base.stack, holding: retired, kind }
  const oldCtx = {
    ...base,
    stack: oldPair,
    deployment: { ...base.deployment, stacks: { main: oldPair } },
    publicClient: client,
  } as unknown as sdk.Ctx
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const config = {
    network: 'monad-testnet' as const,
    domain: 'cache.test',
    uri: 'https://cache.test',
    manifestBaseUrl: 'https://cache.test/offers',
    now: () => 1000,
  }
  const input = {
    title: 'Frozen original offer',
    brief: 'Preserve the original pair',
    acceptanceCriteria: ['works'],
    mode: 'hire' as const,
    token: base.deployment.rewardTokens[0]!,
    reward: '1',
    creatorBond: '1',
    workerBond: '0',
    deliveryDeadline: 2000,
    windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 },
    arbitrator: '0x4444444444444444444444444444444444444444',
  }
  const original = new Board(sql, { ...config, contexts: { main: oldCtx } })
  const direct = await original.createTask({ address: creator }, { ...input, idempotencyKey: 'create' })
  const request = await original.requestQuotes(
    { address: creator },
    { ...input, tokens: [input.token], quoteDeadline: 1900 },
  )
  const quote = await original.submitQuote(
    { address: worker },
    { requestId: request.requestId, agentId: '7', token: input.token, amount: '1' },
  )
  const picked = await original.pickQuote(
    { address: creator },
    { requestId: request.requestId, quoteId: quote.quoteId, idempotencyKey: 'pick' },
  )
  const taskKey = `pick-${sdk.hashText('pick').slice(2)}`
  const quoteBinding = { requestHash: request.requestHash, quoteHash: quote.quoteHash }
  const newCtx = (): sdk.Ctx => ({ ...base, publicClient: client }) as unknown as sdk.Ctx
  const boot = (keep = false, raceOperation?: string) => {
    let hidden = false
    return new Board(
      {
        ...sql,
        all: <T>(query: string, ...params: SqlValue[]) => {
          // Model a competing request winning between the first lookup and atomic persistence.
          if (
            !hidden &&
            raceOperation !== undefined &&
            query.includes('FROM hosted_idempotency') &&
            params[1] === raceOperation
          ) {
            hidden = true
            return [] as T[]
          }
          return sql.all<T>(query, ...params)
        },
      },
      { ...config, contexts: { main: newCtx() } },
    )
  }
  const snapshot = () =>
    ['tasks', 'operations', 'hosted_idempotency', 'quote_requests', 'quotes', 'applications'].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    )
  const retry = (board: Board, operation: 'create_task' | 'pick_task' | 'pick_quote') =>
    operation === 'pick_quote'
      ? board.pickQuote(
          { address: creator },
          { requestId: request.requestId, quoteId: quote.quoteId, idempotencyKey: 'pick' },
        )
      : board.createTask(
          { address: creator },
          { ...input, idempotencyKey: operation === 'create_task' ? 'create' : taskKey },
          operation === 'pick_task' ? quoteBinding : null,
        )
  read.mockClear()
  blockNumber.mockClear()
  return { db, boot, read, blockNumber, input, direct, picked, retry, snapshot, taskKey, quoteBinding, request }
}

for (const operation of ['create_task', 'pick_task', 'pick_quote'] as const) {
  it(`${operation} early cache refuses a retired Holding before RPC and preserves its preparation`, async () => {
    const f = await fixture('sidequest-v1'),
      before = f.snapshot()
    await expect(f.retry(f.boot(), operation)).rejects.toMatchObject({ code: 'unavailable' })
    expect(f.read).not.toHaveBeenCalled()
    expect(f.blockNumber).not.toHaveBeenCalled()
    expect(f.snapshot()).toEqual(before)
  })
}
it('a crash between pick_task and pick_quote refuses a retired nested draft before RPC', async () => {
  const f = await fixture('sidequest-v1')
  f.db.prepare("DELETE FROM hosted_idempotency WHERE operation='pick_quote'").run()
  f.db.prepare('UPDATE quote_requests SET task_id=NULL').run()
  const before = f.snapshot()
  await expect(f.retry(f.boot(), 'pick_quote')).rejects.toMatchObject({ code: 'unavailable' })
  expect(f.read).not.toHaveBeenCalled()
  expect(f.blockNumber).not.toHaveBeenCalled()
  expect(f.snapshot()).toEqual(before)
})
