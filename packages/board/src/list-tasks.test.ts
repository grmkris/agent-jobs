import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@agent-jobs/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'
import { canonicalJson, termsHash, type OfferTerms } from './terms.ts'

const alice = '0x1111111111111111111111111111111111111111' as const
const bob = '0x2222222222222222222222222222222222222222' as const
const carol = '0x3333333333333333333333333333333333333333' as const
const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function fixture() {
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const read = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'policyListed' || functionName === 'paused') return false
    throw new Error(`unexpected chain read: ${functionName}`)
  })
  const ctx = { ...base, publicClient: { ...base.publicClient, readContract: read } } as unknown as sdk.Ctx
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const sql = fromNodeSqlite(db)
  const board = new Board(sql, { network: 'monad-testnet', contexts: { main: ctx }, domain: 'list.test', uri: 'https://list.test', manifestBaseUrl: 'https://list.test/offers', now: () => 1000 })
  const add = (taskId: string, creator: `0x${string}`, approver: `0x${string}`, createdAt: number) => {
    const terms: OfferTerms = {
      v: 2, taskId, projectId: null, policyVersion: null, mode: 'hire', title: taskId, brief: 'Listed', acceptanceCriteria: [],
      deployment: { chainId: ctx.deployment.chainId, core: ctx.deployment.core, holding: ctx.stack.holding, evaluator: ctx.stack.evaluator, identity: ctx.deployment.identity },
      creator, approver, token: ctx.deployment.rewardTokens[0]!, reward: 5n, creatorBond: 0n, workerBond: 0n,
      deliveryDeadline: 2000, selectionDeadline: null, windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 }, eligibility: null, evidencePolicy: null, quote: null, salt: sdk.EMPTY_HASH,
    }
    sql.run('INSERT INTO tasks (id,creator,stack,terms_json,terms_hash,job_id,from_block,created_at) VALUES (?,?,?,?,?,?,?,?)', taskId, creator, 'main', canonicalJson(terms), termsHash(terms), null, 0, createdAt)
  }
  const apply = (taskId: string, worker: `0x${string}`, note: string) =>
    sql.run('INSERT INTO applications (id, task_id, worker, agent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', `${taskId}-${worker.slice(2, 6)}`, taskId, worker, '7', note, 0)
  add('alice-own', alice, alice, 1)
  add('alice-judges', bob, alice, 2)
  add('invited', bob, bob, 3)
  add('picked', carol, carol, 4)
  add('applied', carol, carol, 5)
  apply('invited', alice, 'direct hire invitation')
  apply('picked', alice.toUpperCase().replace('0X', '0x') as `0x${string}`, 'picked quote q1')
  apply('applied', alice, 'I can do this')
  apply('applied', bob, 'direct hire invitation')
  return { board, read }
}

const ids = (tasks: readonly { taskId: string }[]) => tasks.map(task => task.taskId)

it('filters by role from board records, newest first', async () => {
  const { board } = fixture()
  const me = { address: alice }
  expect(ids(await board.listTasks(me, { role: 'creator' }))).toEqual(['alice-own'])
  expect(ids(await board.listTasks(me, { role: 'approver' }))).toEqual(['alice-judges', 'alice-own'])
  expect(ids(await board.listTasks(me, { role: 'worker' }))).toEqual(['applied', 'picked', 'invited'])
  expect(ids(await board.listTasks(me, { role: 'invited' }))).toEqual(['picked', 'invited'])
  expect(ids(await board.listTasks({ address: bob }, { role: 'invited' }))).toEqual(['applied'])
  expect(ids(await board.listTasks(me, { role: 'invited', limit: 1 }))).toEqual(['picked'])
})

it('filters by chain status and refuses unknown roles, statuses and anonymous role filters', async () => {
  const { board } = fixture()
  expect(ids(await board.listTasks({}, { status: ['awaiting-publish'] }))).toEqual(['applied', 'picked', 'invited', 'alice-judges', 'alice-own'])
  expect(await board.listTasks({}, { status: ['open', 'active'] })).toEqual([])
  expect(ids(await board.listTasks({ address: alice }, { role: 'invited', status: ['awaiting-publish'] }))).toEqual(['picked', 'invited'])
  await expect(board.listTasks({}, { role: 'creator' })).rejects.toMatchObject({ code: 'unauthenticated' })
  await expect(board.listTasks({ address: alice }, { role: 'owner' as never })).rejects.toMatchObject({ code: 'invalid' })
  await expect(board.listTasks({}, { status: ['done' as never] })).rejects.toMatchObject({ code: 'invalid' })
})

it('reads no chain state for tasks a role filter excludes', async () => {
  const { board, read } = fixture()
  await board.listTasks({ address: alice }, { role: 'creator' })
  // One task listed: its publish recovery and pause reads only.
  expect(read.mock.calls.length).toBeLessThanOrEqual(2)
})
