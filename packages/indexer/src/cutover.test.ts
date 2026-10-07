import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import fixture, { fixtureDeployment } from '../test/fixtures/v1-logs.ts'
import {
  contractsFromDeployment,
  fromNodeSqlite,
  migrate,
  releaseLease,
  runOnce,
  stmt,
  type AsyncSql,
  type IndexerConfig,
} from './index.ts'

const chainId = fixtureDeployment.chainId
const old = contractsFromDeployment(fixtureDeployment)
const freshCore = '0x0000000000000000000000000000000000001234'
const fresh = contractsFromDeployment({ ...fixtureDeployment, core: freshCore })
const deployBlock = Number(fixtureDeployment.deployBlock)

function config(contracts = old, block = deployBlock): IndexerConfig {
  return {
    contracts,
    deployBlock: block,
    runner: 'old',
    now: () => 1_000,
    maxPages: 1,
    head: { finalizedBlock: async () => fixture.toBlock, blockHash: async () => null },
    source: {
      logs: async () => ({
        logs: fixture.logs.map((log) =>
          log.address.toLowerCase() === old.core ? { ...log, address: `0x${contracts.core.slice(2)}` as const } : log,
        ),
        nextBlock: fixture.toBlock + 1,
      }),
    },
  }
}

async function seeded() {
  const db = new DatabaseSync(':memory:')
  const sql = fromNodeSqlite(db)
  await migrate(sql)
  await runOnce(sql, config())
  await releaseLease(sql, config())
  return { db, sql }
}

describe('deployment cutover under the indexer lease', () => {
  it('wipes only the changed chain and starts at the new deployment block, once', async () => {
    const { sql } = await seeded()
    await sql.batch([stmt("INSERT INTO jobs (chain_id, job_id, status, updated_block) VALUES (999, '1', 'open', 0)")])
    const cfg = { ...config(fresh, fixture.toBlock + 10), maxPages: 0 }
    expect(await runOnce(sql, cfg)).toMatchObject({ cutover: true, nextBlock: cfg.deployBlock })
    for (const table of [
      'events',
      'protocol_events',
      'jobs',
      'submissions',
      'evidence',
      'rulings',
      'reward_outcomes',
      'bond_outcomes',
      'feedback',
      'top_ups',
      'fee_charges',
      'payout_owed',
    ]) {
      expect(await sql.all(`SELECT * FROM ${table} WHERE chain_id = ?`, chainId)).toEqual([])
    }
    expect(await sql.all('SELECT job_id FROM jobs WHERE chain_id = 999')).toEqual([{ job_id: '1' }])
    expect(await sql.all('SELECT next_block, core_address, deployment_block, block_hash FROM checkpoint')).toEqual([
      { next_block: cfg.deployBlock, core_address: freshCore, deployment_block: cfg.deployBlock, block_hash: null },
    ])
    expect(await runOnce(sql, cfg)).toMatchObject({ cutover: false, nextBlock: cfg.deployBlock })
  })

  it('keeps rows and progress when the core and deployment block are unchanged, ignoring address case', async () => {
    const { sql } = await seeded()
    const jobs = await sql.all('SELECT * FROM jobs')
    expect(await runOnce(sql, { ...config({ ...old, core: old.core.toUpperCase() }), maxPages: 0 })).toMatchObject({
      cutover: false,
      nextBlock: fixture.toBlock + 1,
    })
    expect(await sql.all('SELECT * FROM jobs')).toEqual(jobs)
  })

  it('cuts over when only the deployment block changes and replays checkpoints with unknown provenance', async () => {
    const { sql } = await seeded()
    expect(await runOnce(sql, { ...config(old, deployBlock + 1), maxPages: 0 })).toMatchObject({
      cutover: true,
      nextBlock: deployBlock + 1,
    })
    await sql.batch([stmt('UPDATE checkpoint SET core_address = NULL, deployment_block = NULL')])
    expect(await runOnce(sql, { ...config(), maxPages: 0 })).toMatchObject({ cutover: true, nextBlock: deployBlock })
  })

  it('rolls back a crash after the wipe before the checkpoint, then retries without skipping blocks', async () => {
    const { db, sql } = await seeded()
    const jobs = await sql.all('SELECT * FROM jobs')
    const checkpoint = await sql.all('SELECT * FROM checkpoint')
    db.exec(
      "CREATE TRIGGER crash_checkpoint BEFORE INSERT ON checkpoint BEGIN SELECT RAISE(ABORT, 'crash between wipe and checkpoint'); END",
    )
    const cfg = { ...config(fresh, deployBlock + 1), maxPages: 0 }
    await expect(runOnce(sql, cfg)).rejects.toThrow('crash between wipe and checkpoint')
    expect(await sql.all('SELECT * FROM jobs')).toEqual(jobs)
    expect(await sql.all('SELECT * FROM checkpoint')).toEqual(checkpoint)
    db.exec('DROP TRIGGER crash_checkpoint')
    expect(await runOnce(sql, cfg)).toMatchObject({ cutover: true, nextBlock: deployBlock + 1 })
    expect(await runOnce(sql, config(fresh, deployBlock + 1))).toMatchObject({
      cutover: false,
      nextBlock: fixture.toBlock + 1,
    })
    expect(await sql.all('SELECT * FROM jobs')).toEqual(jobs)
  })

  it('a competing cron cannot wipe while the previous runner holds the lease', async () => {
    const { sql } = await seeded()
    await runOnce(sql, config())
    const checkpoint = await sql.all('SELECT * FROM checkpoint')
    expect(await runOnce(sql, { ...config(fresh), runner: 'new' })).toMatchObject({ lease: false, cutover: false })
    expect(await sql.all('SELECT * FROM checkpoint')).toEqual(checkpoint)
    await releaseLease(sql, config())
    expect(await runOnce(sql, { ...config(fresh, deployBlock + 1), runner: 'new', maxPages: 0 })).toMatchObject({
      lease: true,
      cutover: true,
    })
  })

  it('a slow page cannot overwrite a cutover after its lease expires', async () => {
    const { sql } = await seeded()
    let now = 1_000
    const source = {
      logs: async () => {
        now = 2_000
        await runOnce(sql, { ...config(fresh, deployBlock + 1), runner: 'new', now: () => now, maxPages: 0 })
        return { logs: fixture.logs, nextBlock: fixture.toBlock + 1 }
      },
    }
    await sql.batch([stmt('UPDATE checkpoint SET next_block = ?', deployBlock)])
    await expect(runOnce(sql, { ...config(), source, now: () => now })).rejects.toThrow('NOT NULL')
    expect(await sql.all('SELECT core_address, next_block FROM checkpoint')).toEqual([
      { core_address: freshCore, next_block: deployBlock + 1 },
    ])
    expect(await sql.all('SELECT * FROM jobs')).toEqual([])
  })

  it('an empty database begins at the deployment block as before', async () => {
    const sql: AsyncSql = fromNodeSqlite(new DatabaseSync(':memory:'))
    await migrate(sql)
    const starts: number[] = []
    expect(
      await runOnce(sql, {
        ...config(),
        source: {
          logs: async ({ fromBlock }) => {
            starts.push(fromBlock)
            return { logs: [], nextBlock: fixture.toBlock + 1 }
          },
        },
      }),
    ).toMatchObject({ cutover: false })
    expect(starts).toEqual([deployBlock])
  })

  it('a delayed older runner cannot wipe a new generation after its lease is released', async () => {
    const { sql } = await seeded()
    const current = { ...config(fresh, 200), runner: 'new', maxPages: 0 }
    await runOnce(sql, current)
    await releaseLease(sql, current)
    await sql.batch([
      stmt("INSERT INTO jobs (chain_id, job_id, status, updated_block) VALUES (?, '1', 'open', 200)", chainId),
    ])
    const checkpoint = await sql.all('SELECT * FROM checkpoint')
    const jobs = await sql.all('SELECT * FROM jobs')
    const result = await runOnce(sql, { ...config(old, 100), runner: 'delayed-old' })
    expect(result).toMatchObject({ reason: 'stale-generation', pages: 0, cutover: false, caughtUp: false })
    expect(await sql.all('SELECT * FROM checkpoint')).toEqual(checkpoint)
    expect(await sql.all('SELECT * FROM jobs')).toEqual(jobs)
  })

  it('an equal deployment block with a different core refuses before any chain read or derived write', async () => {
    const { sql } = await seeded()
    const checkpoint = await sql.all('SELECT * FROM checkpoint')
    const jobs = await sql.all('SELECT * FROM jobs')
    const configWithNoReads = {
      ...config(fresh),
      head: {
        finalizedBlock: async () => {
          throw new Error('stale runner read the chain')
        },
        blockHash: async () => {
          throw new Error('stale runner read the chain')
        },
      },
    }
    expect(await runOnce(sql, configWithNoReads)).toMatchObject({ reason: 'stale-generation', cutover: false })
    expect(await sql.all('SELECT * FROM checkpoint')).toEqual(checkpoint)
    expect(await sql.all('SELECT * FROM jobs')).toEqual(jobs)
  })

  it('an operator can explicitly restart the bundled generation by deleting the chain checkpoint', async () => {
    const { sql } = await seeded()
    await sql.batch([stmt('DELETE FROM checkpoint WHERE chain_id = ?', chainId)])
    const starts: number[] = []
    await runOnce(sql, {
      ...config(fresh),
      source: {
        logs: async ({ fromBlock }) => {
          starts.push(fromBlock)
          return { logs: [], nextBlock: fixture.toBlock + 1 }
        },
      },
    })
    expect(starts).toEqual([deployBlock])
    expect(await sql.all('SELECT core_address, deployment_block FROM checkpoint')).toEqual([
      { core_address: freshCore, deployment_block: deployBlock },
    ])
  })
})
