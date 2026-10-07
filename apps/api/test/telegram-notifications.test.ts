import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { fromNodeSqlite, migrate, stmt, type AsyncSql } from '@sidequest/indexer'
import { drainTelegramOutbox, migrateTelegram } from '../src/telegram.ts'
import { queueTelegramNotifications } from '../src/telegram-notifications.ts'

const creator = '0x1111111111111111111111111111111111111111'
const worker = '0x2222222222222222222222222222222222222222'
const donor = '0x3333333333333333333333333333333333333333'
const chain = 10143,
  now = 200000
async function setup() {
  const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
  await migrate(sql)
  await migrateTelegram(sql)
  await sql.batch([
    stmt('INSERT INTO checkpoint VALUES (?, 100, NULL, ?)', chain, now),
    stmt(
      "INSERT INTO jobs (chain_id, job_id, creator, approver, worker, kind, status, outcome, settlement_outcome, review_window, updated_block) VALUES (?, '1', ?, ?, ?, 'sidequest-v1', 'submitted', 'None', 'None', 172800, 20)",
      chain,
      creator,
      creator,
      worker,
    ),
    ...[creator, worker, donor].map((wallet, index) =>
      stmt('INSERT INTO telegram_links VALUES (?, ?, ?, NULL, ?)', String(index + 1), chain, wallet, now - 100000),
    ),
  ])
  return sql
}
async function event(sql: AsyncSql, block: number, name: string, args: unknown, at = now) {
  await sql.batch([
    stmt(
      'INSERT INTO events VALUES (?, ?, ?, 0, ?, ?, ?, ?)',
      chain,
      creator,
      block,
      `tx-${block}`,
      '1',
      name,
      JSON.stringify(args),
    ),
    stmt('INSERT INTO block_times VALUES (?, ?, ?)', chain, block, at),
  ])
}

describe('finalized Telegram notifications', () => {
  it('queues delivery, hired, ruling, deferred collect and refused-push notices once across replay', async () => {
    const sql = await setup()
    await event(sql, 1, 'Published', {})
    await event(sql, 2, 'Activated', {})
    await event(sql, 3, 'JobSubmitted', {})
    await event(sql, 4, 'Ruled', { forWorker: true })
    await event(sql, 5, 'PayoutDeferred', { refundedToHolding: false })
    await event(sql, 6, 'PayoutOwed', { to: donor })
    await queueTelegramNotifications(sql, 'monad-testnet', now, { channel: '@jobs' })
    const before = await sql.all<{ text: string }>('SELECT text FROM telegram_outbox')
    expect(before).toHaveLength(9)
    expect(before.some((r) => r.text.includes('/job/1'))).toBe(true)
    expect(before.some((r) => r.text.includes('Delivery submitted'))).toBe(true)
    expect(before.some((r) => r.text.includes('is active'))).toBe(true)
    expect(before.some((r) => r.text.includes('arbitrator ruled'))).toBe(true)
    expect(before.some((r) => r.text.includes('payout to collect'))).toBe(true)
    await sql.batch([stmt('DELETE FROM telegram_notified_events')])
    await queueTelegramNotifications(sql, 'monad-testnet', now, { channel: '@jobs' })
    expect(await sql.all('SELECT text FROM telegram_outbox')).toEqual(before)
  })

  it.each(['RejectionFinal', 'ArbitrationTimeout'])(
    'includes contributors when %s refunds their top-ups',
    async (outcome) => {
      const sql = await setup()
      await sql.batch([
        stmt("UPDATE jobs SET outcome = ?, status = 'rejected', settlement_outcome = 'Refunded'", outcome),
        stmt("INSERT INTO top_ups VALUES (?, '1', 1, 0, ?, '10', 0, 'topup')", chain, donor),
      ])
      await event(sql, 2, 'JobRejected', {})
      await queueTelegramNotifications(sql, 'monad-testnet', now)
      expect(await sql.all('SELECT wallet FROM telegram_outbox')).toEqual([{ wallet: donor }])
    },
  )

  it('waits for event times and does not send historical events to a new link', async () => {
    const sql = await setup()
    await event(sql, 1, 'Activated', {}, now - 100001)
    await event(sql, 2, 'JobSubmitted', {})
    await sql.batch([stmt('DELETE FROM block_times WHERE block = 2')])
    expect((await queueTelegramNotifications(sql, 'monad-testnet', now)).processed).toBe(1)
    expect(await sql.all('SELECT * FROM telegram_outbox')).toEqual([])
    await sql.batch([stmt('INSERT INTO block_times VALUES (?, 2, ?)', chain, now)])
    expect((await queueTelegramNotifications(sql, 'monad-testnet', now)).processed).toBe(1)
    expect(await sql.all('SELECT * FROM telegram_outbox')).toHaveLength(1)
  })

  it('uses per-job windows, cancels a reminder after rejection, and refuses stale or behind facts', async () => {
    const sql = await setup()
    await sql.batch([
      stmt("INSERT INTO submissions VALUES (?, '1', 'hash', ?, 1, 'submit')", chain, worker),
      stmt('INSERT INTO block_times VALUES (?, 1, ?)', chain, now - 100000),
    ])
    expect((await queueTelegramNotifications(sql, 'monad-testnet', now - 20000)).reminders).toBe(0)
    expect((await queueTelegramNotifications(sql, 'monad-testnet', now, { caughtUp: false })).stale).toBe(true)
    expect((await queueTelegramNotifications(sql, 'monad-testnet', now)).reminders).toBe(1)
    expect(await drainTelegramOutbox(sql, { sendMessage: neverSend }, now)).toMatchObject({ sent: 0, uncertain: 0 })
    await sql.batch([stmt("UPDATE jobs SET status = 'rejected-pending'")])
    expect(await drainTelegramOutbox(sql, { sendMessage: neverSend }, now + 60, 20, true)).toMatchObject({
      sent: 0,
      uncertain: 0,
    })
    expect(
      (await sql.all<{ status: string }>('SELECT status FROM telegram_outbox')).every((r) => r.status === 'cancelled'),
    ).toBe(true)
    await sql.batch([stmt('UPDATE checkpoint SET updated_at = ?', now - 121)])
    expect((await queueTelegramNotifications(sql, 'monad-testnet', now)).stale).toBe(true)
  })
})

async function neverSend(): Promise<{ messageId: number }> {
  throw new Error('must not send')
}
