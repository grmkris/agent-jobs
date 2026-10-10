import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { completedByAgent } from './read.ts'
import { fromNodeSqlite, migrate, stmt } from './store.ts'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

async function fixture() {
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  const sql = fromNodeSqlite(database)
  await migrate(sql)
  const job = async (
    id: string,
    status: string,
    outcome: string | null = null,
    agentId: string | null = '7',
    kind: string | null = 'sidequest-v1',
  ) => {
    await sql.batch([
      stmt(
        'INSERT INTO jobs (chain_id, job_id, agent_id, status, outcome, kind, updated_block) VALUES (?, ?, ?, ?, ?, ?, 100)',
        10143,
        id,
        agentId,
        status,
        outcome,
        kind,
      ),
    ])
  }
  const event = async (jobId: string, name: string, block: number, at: number | null, chainId = 10143) => {
    await sql.batch([
      stmt(
        "INSERT INTO events (chain_id, contract, block, log_index, tx_hash, job_id, name, args_json) VALUES (?, 'fixture', ?, 0, 'fixture', ?, ?, '{}')",
        chainId,
        block,
        jobId,
        name,
      ),
      ...(at === null ? [] : [stmt('INSERT INTO block_times VALUES (?, ?, ?)', chainId, block, at)]),
    ])
  }
  return { sql, job, event }
}

it('counts completed v1 jobs once per agent and uses their original completion time', async () => {
  const { sql, job, event } = await fixture()
  await job('1', 'completed')
  await event('1', 'JobCompleted', 1, 1000)
  await event('1', 'JobCompleted', 2, 1001)
  await job('2', 'completed')
  await event('2', 'JobCompleted', 3, 999)
  // An unrelated recent update or payment retry never makes an old completion recent.
  await event('2', 'RewardSettled', 4, 2000)
  await job('3', 'completed', null, '8')
  await event('3', 'JobCompleted', 5, null)
  await job('4', 'active')
  await job('5', 'rejected', 'RuledForCreator')
  await job('6', 'completed', null, '7', null)
  await job('7', 'completed', null, '0')
  await job('8', 'completed', null, null)
  await sql.batch([
    stmt(
      "INSERT INTO jobs (chain_id, job_id, agent_id, status, kind, updated_block) VALUES (1, '9', '7', 'completed', 'sidequest-v1', 1)",
    ),
  ])
  await event('9', 'JobCompleted', 1, 2000, 1)
  expect(await completedByAgent(sql, 10143, 1000)).toEqual(
    new Map([
      ['7', { delivered: 2, delivered7d: 1 }],
      ['8', { delivered: 1, delivered7d: 0 }],
    ]),
  )
})

it('includes paid-work decisions even while core payout is deferred', async () => {
  const { sql, job, event } = await fixture()
  for (const [id, outcome, name] of [
    ['1', 'Accepted', 'Accepted'],
    ['2', 'Silence', 'TimedOut'],
    ['3', 'RuledForWorker', 'Ruled'],
  ]) {
    await job(id!, 'rejected', outcome)
    await event(id!, name!, Number(id), 1000)
  }
  await job('4', 'expired', 'NoShow')
  await event('4', 'TimedOut', 4, 2000)
  expect(await completedByAgent(sql, 10143, 1000)).toEqual(new Map([['7', { delivered: 3, delivered7d: 3 }]]))
})

it('returns an empty map before any v1 agent has jobs', async () => {
  const { sql } = await fixture()
  expect(await completedByAgent(sql, 10143, 0)).toEqual(new Map())
})
