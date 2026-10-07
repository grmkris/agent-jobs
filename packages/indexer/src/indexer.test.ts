/**
 * The indexer against ABI-encoded synthetic v1 logs, replayed through a scripted source
 * (test double) into node:sqlite. Covers plan S4:
 * duplicate pages, an empty page with an advancing next block, a crash before the checkpoint, overlapping runs,
 * a simulated divergence, and a restart and full rebuild equal to the live state; the folds of known jobs.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import fixture, { fixtureDeployment } from '../test/fixtures/v1-logs.ts'
import {
  type AsyncSql,
  type ChainHead,
  type IndexerConfig,
  type LogSource,
  type RawLog,
  contractsFromDeployment,
  agentDetail,
  agentsOfWallet,
  fromNodeSqlite,
  jobDetail,
  listAgents,
  migrate,
  networkStats,
  releaseLease,
  resetIndex,
  runOnce,
} from './index.ts'

const logs = fixture.logs as unknown as RawLog[]
const historicalDeployment = fixtureDeployment
const contracts = contractsFromDeployment(historicalDeployment)
const deployBlock = Number(historicalDeployment.deployBlock)
const finalized = fixture.toBlock
const hashOf = (b: number) => `0x${b.toString(16).padStart(64, '0')}` as const

/** A block's time in these tests (the fixture has none): one second per block after a fixed start. */
const timeOf = (b: number) => 1_790_000_000 + (b - deployBlock)

/** Pages of at most `perPage` blocks' worth of logs, like HyperSync's partial answers. */
function pagedSource(perPage: number, opts: { repeatFirst?: boolean; emptyFirst?: boolean; times?: boolean } = {}): LogSource & { calls: number } {
  let calls = 0
  const src = {
    calls: 0,
    async logs({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) {
      calls++
      src.calls = calls
      if (opts.emptyFirst === true && calls === 1) return { logs: [], nextBlock: fromBlock + 10 }
      const end = Math.min(toBlock, fromBlock + perPage)
      const page = logs.filter((l) => l.block_number >= fromBlock && l.block_number < end)
      if (opts.times !== true) return { logs: page, nextBlock: end }
      return { logs: page, nextBlock: end, blockTimes: [...new Set(page.map((l) => l.block_number))].map((block) => ({ block, timestamp: timeOf(block) })) }
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
  for (const t of ['events', 'protocol_events', 'jobs', 'submissions', 'evidence', 'rulings', 'reward_outcomes', 'bond_outcomes', 'feedback']) {
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

describe('indexer on synthetic v1 logs', () => {
  it('folds known jobs: ruled for the worker, ruled for the creator with a burn, an approved hire', async () => {
    const job = async (id: number) => (await liveDb.all<Record<string, unknown>>('SELECT * FROM jobs WHERE job_id = ?', String(id)))[0]
    expect(await job(9)).toMatchObject({ status: 'completed', stack: 'main', mode: 'hire', violation: 'None' })
    expect(await liveDb.all('SELECT for_worker, slash_loser FROM rulings WHERE job_id = ?', '9')).toEqual([{ for_worker: 1, slash_loser: 0 }])
    expect(await job(10)).toMatchObject({ status: 'rejected', violation: 'Quality' })
    expect(await liveDb.all("SELECT side FROM bond_outcomes WHERE job_id = ? AND outcome = 'burned'", '10')).toEqual([{ side: 'worker' }])
    expect(await job(8)).toMatchObject({ status: 'completed', mode: 'hire' })
    // Evidence matches the submitted hire deliverable.
    expect(await liveDb.all('SELECT matches_onchain FROM evidence WHERE job_id = ?', '8')).toEqual([{ matches_onchain: 1 }])
    expect(await liveDb.all('SELECT recipient, amount FROM reward_outcomes WHERE job_id = ? AND kind = ?', '8', 'paid')).toEqual([
      { recipient: '0x0000000000000000000000000000000000000015', amount: '7000000' },
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

  it('reports caught up only once every block finalized when the run began is indexed', async () => {
    const sql = await freshDb()
    const partial = await runOnce(sql, config({ maxPages: 1, source: pagedSource(1000) }))
    expect(partial).toMatchObject({ lease: true, caughtUp: false })
    expect(await runOnce(sql, config({ runner: 'b' }))).toMatchObject({ lease: false, caughtUp: false })
    expect(await runToEnd(sql, config())).toMatchObject({ lease: true, caughtUp: true })
  })

  it('a released lease lets the next runner start at once', async () => {
    const sql = await freshDb()
    const first = config({ maxPages: 1, source: pagedSource(1000) })
    await runOnce(sql, first)
    await releaseLease(sql, config({ runner: 'b' }))
    expect((await runOnce(sql, config({ runner: 'b', maxPages: 1, source: pagedSource(1000) }))).lease).toBe(false)
    await releaseLease(sql, first)
    expect((await runOnce(sql, config({ runner: 'b', maxPages: 1, source: pagedSource(1000) }))).lease).toBe(true)
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

describe('block times for job timelines', () => {
  it('stores the times HyperSync joins to a page, and a job detail lists its events with them', async () => {
    const sql = await freshDb()
    await runToEnd(sql, config({ source: pagedSource(1_000_000, { times: true }) }))
    const detail = await jobDetail(sql, contracts.chainId, '9', 0)
    const timeline = detail?.timeline ?? []
    expect(timeline.map((e) => e.name)).toContain('Ruled')
    expect(timeline.every((e) => e.at === timeOf(e.block))).toBe(true)
    expect(timeline.map((e) => e.block)).toEqual(timeline.map((e) => e.block).toSorted((a, b) => a - b))
  })

  it('backfills blocks indexed without times, a bounded number per run, newest first', async () => {
    const sql = await freshDb()
    await runToEnd(sql, config())
    const [{ n: blocks } = { n: 0 }] = await sql.all<{ n: number }>('SELECT count(*) AS n FROM (SELECT block FROM events UNION SELECT block FROM protocol_events)')
    expect(blocks).toBeGreaterThan(10)
    const lookups: number[] = []
    const timed: ChainHead = { ...head(), blockTimestamp: async (b) => (lookups.push(b), timeOf(b)) }
    const r = await runOnce(sql, config({ head: timed, backfillBlocks: 10 }))
    expect(r.backfilled).toBe(10)
    expect(lookups).toEqual(lookups.toSorted((a, b) => b - a))
    for (let i = 0; i < 100 && (await runOnce(sql, config({ head: timed, backfillBlocks: 10 }))).backfilled > 0; i++);
    const [{ n: timedBlocks } = { n: 0 }] = await sql.all<{ n: number }>('SELECT count(*) AS n FROM block_times')
    expect(timedBlocks).toBe(blocks)
    // The chain facts are the live state; block times sit beside them.
    expect(await snapshot(sql)).toEqual(live)
  })
})

describe('agent reads', () => {
  it('discovers the v1 worker, jobs and aggregate stats from the same replayed logs', async () => {
    expect(await listAgents(liveDb, contracts.chainId)).toMatchObject([{ agentId: '7', jobs: 3 }])
    const [worker] = await liveDb.all<{ worker: string }>("SELECT worker FROM jobs WHERE agent_id = '7' LIMIT 1")
    expect(await agentsOfWallet(liveDb, contracts.chainId, worker!.worker)).toHaveLength(1)
    expect((await agentDetail(liveDb, contracts.chainId, '7'))?.jobs).toHaveLength(3)
    expect(await networkStats(liveDb, contracts.chainId)).toMatchObject({ jobs: 3, completed: 2, agents: 1 })
  })
})
