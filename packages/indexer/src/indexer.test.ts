/**
 * The indexer against the real logs of the testnet deployment (captured from HyperSync into a fixture, so the
 * test is deterministic), replayed through a scripted source (test double) into node:sqlite. Covers plan S4:
 * duplicate pages, an empty page with an advancing next block, a crash before the checkpoint, overlapping runs,
 * a simulated divergence, and a restart and full rebuild equal to the live state; the folds of known jobs.
 */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@agent-jobs/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import fixture from '../test/fixtures/testnet-logs.json' with { type: 'json' }
import {
  type AsyncSql,
  type ChainHead,
  type IndexerConfig,
  type LogSource,
  type RawLog,
  contractsOf,
  fromNodeSqlite,
  migrate,
  resetIndex,
  runOnce,
} from './index.ts'

const logs = fixture.logs as unknown as RawLog[]
const contracts = contractsOf('monad-testnet')
const deployBlock = Number(sdk.deployment('monad-testnet').deployBlock)
const finalized = fixture.toBlock
const hashOf = (b: number) => `0x${b.toString(16).padStart(64, '0')}` as const

/** Pages of at most `perPage` blocks' worth of logs, like HyperSync's partial answers. */
function pagedSource(perPage: number, opts: { repeatFirst?: boolean; emptyFirst?: boolean } = {}): LogSource & { calls: number } {
  let calls = 0
  const src = {
    calls: 0,
    async logs({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) {
      calls++
      src.calls = calls
      if (opts.emptyFirst === true && calls === 1) return { logs: [], nextBlock: fromBlock + 10 }
      const end = Math.min(toBlock, fromBlock + perPage)
      return { logs: logs.filter((l) => l.block_number >= fromBlock && l.block_number < end), nextBlock: end }
    },
  }
  return src
}

const head = (hashes: (b: number) => `0x${string}` = hashOf): ChainHead => ({
  finalizedBlock: async () => finalized,
  blockHash: async (b) => hashes(b),
})

function config(over: Partial<IndexerConfig> = {}): IndexerConfig {
  return { contracts, deployBlock, source: pagedSource(2000), head: head(), runner: 'a', now: () => 1_000, maxPages: 10_000, ...over }
}

async function freshDb(): Promise<AsyncSql> {
  const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
  await migrate(sql)
  return sql
}

async function runToEnd(sql: AsyncSql, cfg: IndexerConfig) {
  for (let i = 0; i < 100; i++) {
    const r = await runOnce(sql, cfg)
    if (r.nextBlock !== null && r.nextBlock > finalized) return r
  }
  throw new Error('did not reach the head')
}

async function snapshot(sql: AsyncSql) {
  const out: Record<string, unknown[]> = {}
  for (const t of ['events', 'jobs', 'submissions', 'evidence', 'rulings', 'reward_outcomes', 'bond_outcomes', 'feedback']) {
    out[t] = await sql.all(`SELECT * FROM ${t} ORDER BY 1, 2, 3, 4`)
  }
  return out
}

let live: Record<string, unknown[]>
let liveDb: AsyncSql

beforeEach(async () => {
  liveDb = await freshDb()
  await runToEnd(liveDb, config({ source: pagedSource(1_000_000) }))
  live = await snapshot(liveDb)
})

describe('indexer on the real testnet logs', () => {
  it('folds known jobs: ruled for the worker, ruled for the creator with a burn, a contest award', async () => {
    const job = async (id: number) => (await liveDb.all<Record<string, unknown>>('SELECT * FROM jobs WHERE job_id = ?', String(id)))[0]
    expect(await job(9)).toMatchObject({ status: 'completed', stack: 'demo', mode: 'hire', violation: 'None' })
    expect(await liveDb.all('SELECT for_worker, slash_loser FROM rulings WHERE job_id = ?', '9')).toEqual([{ for_worker: 1, slash_loser: 0 }])
    expect(await job(10)).toMatchObject({ status: 'rejected', violation: 'Quality' })
    expect(await liveDb.all("SELECT side FROM bond_outcomes WHERE job_id = ? AND outcome = 'burned'", '10')).toEqual([{ side: 'worker' }])
    expect(await job(8)).toMatchObject({ status: 'completed', mode: 'contest' })
    // The candidate's evidence was attached before the award; it matches the deliverable the award submitted.
    expect(await liveDb.all('SELECT matches_onchain FROM evidence WHERE job_id = ?', '8')).toEqual([{ matches_onchain: 1 }])
    expect(await liveDb.all('SELECT recipient, amount FROM reward_outcomes WHERE job_id = ? AND kind = ?', '8', 'paid')).toEqual([
      { recipient: '0xD7e3b7B7229196B8b65F97fc5544231dd4a7E571', amount: '7000000' },
    ])
  })

  it('small pages, a duplicate page and an empty page with an advancing next block give the live state', async () => {
    const sql = await freshDb()
    await runToEnd(sql, config({ source: pagedSource(137, { emptyFirst: true }) }))
    expect(await snapshot(sql)).toEqual(live)
    // Replaying from the deploy block again (every page a duplicate) changes nothing.
    await sql.batch([{ query: 'UPDATE checkpoint SET next_block = ?', params: [deployBlock] }])
    await runToEnd(sql, config({ source: pagedSource(500) }))
    expect(await snapshot(sql)).toEqual(live)
  })

  it('a crash before the checkpoint leaves no partial page; a restart reaches the live state', async () => {
    const sql = await freshDb()
    let batches = 0
    const crashing: AsyncSql = {
      all: sql.all,
      batch: async (s) => {
        batches++
        if (batches === 6) throw new Error('crash')
        return sql.batch(s)
      },
    }
    await expect(runToEnd(crashing, config({ source: pagedSource(300) }))).rejects.toThrow('crash')
    const [cp] = await sql.all<{ next_block: number }>('SELECT next_block FROM checkpoint')
    const events = await sql.all<{ n: number }>('SELECT count(*) AS n FROM events WHERE block >= ?', cp?.next_block ?? 0)
    expect(events[0]?.n).toBe(0)
    await runToEnd(sql, config({ source: pagedSource(300), now: () => 2_000 }))
    expect(await snapshot(sql)).toEqual(live)
  })

  it('overlapping runs: the second runner does nothing while the lease holds', async () => {
    const sql = await freshDb()
    const first = await runOnce(sql, config({ maxPages: 1, source: pagedSource(1000) }))
    expect(first.lease).toBe(true)
    const second = await runOnce(sql, config({ runner: 'b' }))
    expect(second).toMatchObject({ lease: false, pages: 0 })
    // After the lease expires the other runner takes over and reaches the same state.
    await runToEnd(sql, config({ runner: 'b', now: () => 5_000 }))
    expect(await snapshot(sql)).toEqual(live)
  })

  it('a divergent last block rewinds and re-indexes to the same state', async () => {
    const sql = await freshDb()
    await runToEnd(sql, config())
    const diverged = head((b) => (b === finalized ? `0x${'ff'.repeat(32)}` : hashOf(b)))
    const r = await runOnce(sql, config({ head: diverged }))
    expect(r.rewound).toBe(true)
    await runToEnd(sql, config())
    expect(await snapshot(sql)).toEqual(live)
  })

  it('a full rebuild from the deploy block equals the live state', async () => {
    await resetIndex(liveDb, config())
    expect((await liveDb.all('SELECT * FROM jobs')).length).toBe(0)
    await runToEnd(liveDb, config({ source: pagedSource(777) }))
    expect(await snapshot(liveDb)).toEqual(live)
  })
})
