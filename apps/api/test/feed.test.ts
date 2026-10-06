import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { fromNodeSqlite, migrate, stmt, type AsyncSql } from '@sidequest/indexer'
import { FEED_RETENTION_SECONDS, feedFromChain, pruneFeed, readInbox, writeFeed } from '../src/feed.ts'
import { migrateRegistry } from '../src/registry.ts'

const creator = '0x1111111111111111111111111111111111111111'
const worker = '0x2222222222222222222222222222222222222222'
const stranger = '0x3333333333333333333333333333333333333333'
const chain = 10143, now = 2_000_000
const termsHash = `0x${'ab'.repeat(32)}`

async function setup() {
  const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
  await migrate(sql)
  await migrateRegistry(sql)
  await sql.batch([
    stmt('INSERT INTO checkpoint VALUES (?, 100, NULL, ?)', chain, now),
    stmt("INSERT INTO jobs (chain_id, job_id, creator, approver, worker, kind, status, policy_hash, updated_block) VALUES (?, '7', ?, ?, ?, 'sidequest-v1', 'submitted', ?, 20)", chain, creator, creator, worker, termsHash),
    stmt("INSERT INTO board_offers VALUES (?, 'public', 'task-7', ?)", termsHash, now),
  ])
  return sql
}
async function event(sql: AsyncSql, block: number, name: string, args: unknown = {}) {
  await sql.batch([
    stmt('INSERT INTO events VALUES (?, ?, ?, 0, ?, ?, ?, ?)', chain, creator, block, `tx-${block}`, '7', name, JSON.stringify(args)),
    stmt('INSERT INTO block_times VALUES (?, ?, ?)', chain, block, now - 100 + block),
  ])
}
const read = (sql: AsyncSql, address: string, extra: Record<string, unknown> = {}) => readInbox(sql, { network: 'monad-testnet', address, now, ...extra })

describe('feed from finalized chain events', () => {
  it('addresses each transition to its parties with the board task, once across replay', async () => {
    const sql = await setup()
    for (const [block, name] of [[1, 'Published'], [2, 'Activated'], [3, 'JobSubmitted'], [4, 'Rejected']] as const) await event(sql, block, name)
    await event(sql, 5, 'PayoutOwed', { to: worker })
    expect(await feedFromChain(sql, 'monad-testnet', now, { caughtUp: true })).toEqual({ processed: 5, stale: false, waiting: false })
    const mine = await read(sql, worker, { includePublic: false })
    expect(mine.events.map(e => [e.kind, e.role])).toEqual([['job.activated', 'worker'], ['job.rejected', 'worker'], ['payout.owed', 'recipient']])
    expect(mine.events[1]).toMatchObject({ taskId: 'task-7', boardId: 'public', jobId: '7', next: { tool: 'get_task', args: { taskId: 'task-7' } }, url: 'https://dev.sidequest.exchange/job/7' })
    expect(mine.events[2]!.next).toEqual({ tool: 'settlement_actions', args: { taskId: 'task-7' } })
    const theirs = await read(sql, creator)
    expect(theirs.events.map(e => e.kind)).toEqual(['job.published', 'job.published', 'job.activated', 'job.submitted', 'job.rejected'])
    expect(theirs.events.filter(e => e.public)).toHaveLength(1)
    // A replay from scratch (lost checkpoint) inserts nothing new.
    await sql.batch([stmt('DELETE FROM feed_checkpoints')])
    await feedFromChain(sql, 'monad-testnet', now, { caughtUp: true })
    expect((await sql.all<{ n: number }>('SELECT count(*) AS n FROM feed_events'))[0]!.n).toBe(8)
  })

  it('never feeds from a stale or lagging index', async () => {
    const sql = await setup()
    await event(sql, 1, 'Activated')
    expect(await feedFromChain(sql, 'monad-testnet', now, { caughtUp: false })).toMatchObject({ stale: true })
    expect(await feedFromChain(sql, 'monad-testnet', now + 1000, { caughtUp: true })).toMatchObject({ stale: true })
    expect((await read(sql, worker)).events).toEqual([])
  })
})

describe('feed from chain gaps and history', () => {
  it('stops before an event whose block time is missing and resumes once it is backfilled (VV2-024)', async () => {
    const sql = await setup()
    await event(sql, 1, 'Activated')
    await sql.batch([stmt('INSERT INTO events VALUES (?, ?, 2, 0, ?, ?, ?, ?)', chain, creator, 'tx-2', '7', 'JobSubmitted', '{}')])
    await event(sql, 3, 'Rejected')
    expect(await feedFromChain(sql, 'monad-testnet', now, { caughtUp: true })).toEqual({ processed: 1, stale: false, waiting: true })
    expect(await feedFromChain(sql, 'monad-testnet', now, { caughtUp: true })).toEqual({ processed: 0, stale: false, waiting: true })
    await sql.batch([stmt('INSERT INTO block_times VALUES (?, 2, ?)', chain, now - 98)])
    expect(await feedFromChain(sql, 'monad-testnet', now, { caughtUp: true })).toEqual({ processed: 2, stale: false, waiting: false })
    expect((await read(sql, creator)).events.map(e => e.kind)).toEqual(['job.activated', 'job.submitted', 'job.rejected'])
  })

  it('starts a fresh feed after events already past retention, so history does not arrive as new', async () => {
    const sql = await setup()
    const old = now - FEED_RETENTION_SECONDS - 1000
    await sql.batch([
      stmt('INSERT INTO events VALUES (?, ?, 1, 0, ?, ?, ?, ?)', chain, creator, 'tx-1', '7', 'Activated', '{}'),
      stmt('INSERT INTO block_times VALUES (?, 1, ?)', chain, old),
    ])
    await event(sql, 5, 'JobSubmitted')
    expect(await feedFromChain(sql, 'monad-testnet', now, { caughtUp: true })).toMatchObject({ processed: 1 })
    expect((await read(sql, creator)).events.map(e => e.kind)).toEqual(['job.submitted'])
  })
})

describe('inbox', () => {
  it('pages by cursor, filters kinds, keeps strangers out and reports retention gaps', async () => {
    const sql = await setup()
    await writeFeed(sql, 'monad-testnet', Array.from({ length: 5 }, (_, i) => ({ id: `t:${i}`, address: worker, kind: i % 2 === 0 ? 'quote.received' : 'selection.received', summary: `s${i}`, occurredAt: now })), now)
    await writeFeed(sql, 'monad-testnet', [{ id: 'other', address: stranger, kind: 'quote.received', summary: 'not yours', occurredAt: now }], now)
    const first = await read(sql, worker, { limit: 2 })
    expect(first.events.map(e => e.summary)).toEqual(['s0', 's1'])
    expect(first).toMatchObject({ hasMore: true, nextPollSeconds: 0, gap: false })
    const second = await read(sql, worker, { cursor: first.cursor, limit: 10 })
    expect(second.events.map(e => e.summary)).toEqual(['s2', 's3', 's4'])
    expect(second).toMatchObject({ hasMore: false, nextPollSeconds: 60 })
    expect((await read(sql, worker, { cursor: second.cursor })).events).toEqual([])
    expect((await read(sql, worker, { cursor: second.cursor })).cursor).toBe(second.cursor)
    expect((await read(sql, worker, { kinds: ['selection.received'] })).events.map(e => e.summary)).toEqual(['s1', 's3'])
    expect((await read(sql, stranger)).events.map(e => e.summary)).toEqual(['not yours'])
    await expect(read(sql, worker, { cursor: 'seq=1' })).rejects.toThrow(/cursor/)
    // Old rows age out; a poller holding an older cursor learns it may have missed some.
    await sql.batch([stmt('UPDATE feed_events SET created_at = ? WHERE id IN (?, ?)', now - FEED_RETENTION_SECONDS - 1, 't:0', 't:1')])
    await pruneFeed(sql, now)
    expect(await read(sql, worker, { cursor: 'v1:0' })).toMatchObject({ gap: true })
  })
})
