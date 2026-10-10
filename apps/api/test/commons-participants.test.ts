import { DatabaseSync } from 'node:sqlite'
import { Effect, Schema } from 'effect'
import { afterEach, expect, it, vi } from 'vitest'
import { Board, fromNodeSqlite, participantsOf } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { participantsLive } from '../src/commons/participants.ts'
import { tools } from '../src/tools.ts'
import type { BoardCall } from '../src/board.ts'

const creator = '0x1111111111111111111111111111111111111111' as const
const approver = '0x2222222222222222222222222222222222222222' as const
const bidder = '0x3333333333333333333333333333333333333333' as const
const worker = '0x4444444444444444444444444444444444444444' as const
const now = 1_791_000_000
const handles: DatabaseSync[] = []
afterEach(() => {
  for (const db of handles.splice(0)) db.close()
})
const env: BoardCall['env'] = {
  network: 'monad-testnet',
  boardId: 'public',
  rpcUrl: '',
  domain: '',
  uri: '',
  manifestBaseUrl: '',
  screening: { baseUrl: '', apiKey: '', model: '' },
  attesterKey: '',
  relayKey: '',
  github: { appId: '', privateKeyPem: '', installationId: '' },
}
function fixture() {
  const base = sdk.context(env.network, 'main', 'http://127.0.0.1:1')
  const values = new Map<string, unknown>([
    ['paused', false],
    ['minimumCreatorBond', 10n ** 18n],
    ['unfilledForfeitBps', 2500],
    ['CANCEL_GRACE', 600],
    ['treasury', base.deployment.sidequest!.safe],
    ['UNSTAKE_DELAY', 259200],
    ['decimals', 0],
    ['symbol', 'mUSD'],
    ['getAgentWallet', bidder],
    ['allowance', 0n],
    ['margin', 120],
    ['MIN_REVIEW_WINDOW', 120],
    ['MIN_DISPUTE_WINDOW', 120],
    ['MIN_ARBITRATION_WINDOW', 300],
  ])
  const readContract = async ({ functionName }: { functionName: string }) => {
    if (functionName.startsWith('MAX_')) return sdk.MAX_SIDEQUEST_WINDOW
    if (!values.has(functionName)) throw new Error(`Unexpected read ${functionName}`)
    return values.get(functionName)
  }
  // SAFETY: creation and quote calls only read timestamp from this hermetic block.
  const block = { timestamp: BigInt(now) } as Awaited<ReturnType<sdk.Ctx['publicClient']['getBlock']>>
  // SAFETY: the test client implements the Board reads exercised by this fixture.
  const context = {
    ...base,
    publicClient: {
      ...base.publicClient,
      readContract,
      getBlockNumber: async () => 100n,
      getBlock: async () => block,
    },
  } as sdk.Ctx
  const db = new DatabaseSync(':memory:')
  handles.push(db)
  const sql = fromNodeSqlite(db)
  const board = new Board(sql, {
    network: env.network,
    contexts: { main: context },
    domain: 'test.invalid',
    uri: 'https://test.invalid',
    manifestBaseUrl: 'https://test.invalid/offers',
    now: () => now,
  })
  const run = async (name: string, args: Record<string, unknown>, address: `0x${string}` = creator) =>
    Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
      await tools[name]!.run(board, { address }, args, { network: env.network, mcpSession: undefined }),
    )
  const offer = {
    title: 'Offer',
    brief: 'Brief',
    acceptanceCriteria: ['works'],
    creatorBond: '1',
    workerBond: '0',
    deliveryDeadline: now + 86400,
    approver,
    arbitrator: worker,
    windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 },
  }
  return { sql, run, offer, token: base.deployment.rewardTokens[0]! }
}

it('reads participants from real create_task, request_quotes, submit_quote and pick_quote records', async () => {
  const f = fixture()
  const task = await f.run('create_task', { ...f.offer, token: f.token, reward: '1' })
  expect(participantsOf(f.sql, String(task.taskId))).toMatchObject({ creator, approver, worker: null, bidders: [] })
  const request = await f.run('request_quotes', { ...f.offer, tokens: [f.token], quoteDeadline: now + 3600 })
  const quote = await f.run(
    'submit_quote',
    { requestId: request.requestId, agentId: '7', token: f.token, amount: '1' },
    bidder,
  )
  const picked = await f.run('pick_quote', { requestId: request.requestId, quoteId: quote.quoteId })
  const taskId = Schema.decodeUnknownSync(Schema.String)(picked.taskId)
  expect(participantsOf(f.sql, taskId)).toMatchObject({ creator, approver, worker: null, bidders: [bidder] })
  const selectedTaskId = Schema.decodeUnknownSync(Schema.String)(picked.taskId)
  const selectedApplicationId = Schema.decodeUnknownSync(Schema.String)(picked.applicationId)
  f.sql.run(
    'INSERT INTO selections (task_id,nonce,application_id,worker,agent_id,activate_by,signature,created_at) VALUES (?,?,?,?,?,?,?,?)',
    selectedTaskId,
    '1',
    selectedApplicationId,
    worker,
    '8',
    now + 100,
    null,
    now,
  )
  expect(participantsOf(f.sql, selectedTaskId)?.worker).toBeNull()
  f.sql.run('UPDATE selections SET signature=? WHERE task_id=?', '0xsigned', selectedTaskId)
  expect(participantsOf(f.sql, selectedTaskId)?.worker).toBe(worker)
  expect(participantsOf(f.sql, 'unknown')).toBeNull()
})

it('checks board registration before issuing any namespace lookup or RPC', async () => {
  const getByName = vi.fn(() => ({ jobParticipants: vi.fn() }))
  const sql = { all: async <T>() => new Array<T>(), batch: async () => {} }
  expect(await Effect.runPromise(participantsLive(sql, { getByName }, env).of('missing', 'task'))).toBeNull()
  expect(getByName).not.toHaveBeenCalled()
})

it('adds the indexed on-chain worker for a public board and fails closed on invalid RPC data', async () => {
  const jobParticipants = vi.fn(async () =>
    JSON.stringify({ creator, approver, worker: null, bidders: [bidder], arbitrator: null, jobId: '99' }),
  )
  // SAFETY: the SQL fixture returns the worker column selected by this single query.
  const sql = { all: async <T>() => [{ worker }] as T[], batch: async () => {} }
  const service = participantsLive(sql, { getByName: () => ({ jobParticipants }) }, env)
  expect(await Effect.runPromise(service.of('public', 'task'))).toMatchObject({ worker, bidders: [bidder] })
  expect(jobParticipants).toHaveBeenCalledWith({ env, taskId: 'task' })
  jobParticipants.mockResolvedValue('not json')
  expect(await Effect.runPromise(service.of('public', 'task').pipe(Effect.flip))).toMatchObject({ _tag: 'Unavailable' })
})
