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
  agentDetail,
  agentsOfWallet,
  fromNodeSqlite,
  jobDetail,
  listAgents,
  migrate,
  networkStats,
  resetIndex,
  runOnce,
} from './index.ts'

const logs = fixture.logs as unknown as RawLog[]
const contracts = contractsOf('monad-testnet')
const deployBlock = Number(sdk.deployment('monad-testnet').deployBlock)
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

describe('indexer on the real testnet logs', () => {
  it('folds known jobs: ruled for the worker, ruled for the creator with a burn, a contest award', async () => {
    const job = async (id: number) => (await liveDb.all<Record<string, unknown>>('SELECT * FROM jobs WHERE job_id = ?', String(id)))[0]
    expect(await job(9)).toMatchObject({ status: 'completed', stack: 'demo-v1', mode: 'hire', violation: 'None' })
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
  it('lists every agent that took a job, most completed first, with earnings summed per token', async () => {
    const agents = await listAgents(liveDb, contracts.chainId)
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.map((a) => a.completed)).toEqual(agents.map((a) => a.completed).toSorted((a, b) => b - a))
    const jobs = await liveDb.all<{ agent_id: string; status: string }>("SELECT agent_id, status FROM jobs WHERE agent_id IS NOT NULL AND agent_id <> '0'")
    for (const a of agents) {
      expect(a.jobs).toBe(jobs.filter((j) => j.agent_id === a.agentId).length)
      expect(a.completed).toBe(jobs.filter((j) => j.agent_id === a.agentId && j.status === 'completed').length)
    }
    const paid = await liveDb.all<{ agent_id: string; token: string; amount: string }>(
      "SELECT j.agent_id, j.token, r.amount FROM reward_outcomes r JOIN jobs j USING (chain_id, job_id) WHERE r.kind = 'paid' AND lower(r.recipient) = lower(j.worker)",
    )
    for (const a of agents) {
      for (const [token, total] of Object.entries(a.earned)) {
        const expected = paid.filter((p) => p.agent_id === a.agentId && p.token === token).reduce((sum, p) => sum + BigInt(p.amount), 0n)
        expect(total).toBe(expected.toString())
      }
    }
  })

  it("finds a wallet's agents whatever the address case, and an agent's record", async () => {
    const wallet = '0xD7e3b7B7229196B8b65F97fc5544231dd4a7E571'
    const ids = await agentsOfWallet(liveDb, contracts.chainId, wallet.toLowerCase())
    expect(ids.length).toBeGreaterThan(0)
    const detail = await agentDetail(liveDb, contracts.chainId, ids[0] as string)
    expect(detail?.wallets).toContain(wallet)
    expect(detail?.jobs.every((j) => j.agent_id === ids[0])).toBe(true)
    expect(detail?.agent.jobs).toBe(detail?.jobs.length)
    expect(await agentDetail(liveDb, contracts.chainId, '999999999')).toBeUndefined()
  })

  it('network stats agree with the job rows', async () => {
    const stats = await networkStats(liveDb, contracts.chainId)
    const jobs = await liveDb.all<{ status: string }>('SELECT status FROM jobs')
    expect(stats.jobs).toBe(jobs.length)
    expect(stats.completed).toBe(jobs.filter((j) => j.status === 'completed').length)
    const paid = await liveDb.all<{ token: string; amount: string }>("SELECT j.token, r.amount FROM reward_outcomes r JOIN jobs j USING (chain_id, job_id) WHERE r.kind = 'paid'")
    const total = paid.reduce((sum, p) => sum + BigInt(p.amount), 0n)
    expect(Object.values(stats.paidOut).reduce((sum, v) => sum + BigInt(v), 0n)).toBe(total)
  })
})
