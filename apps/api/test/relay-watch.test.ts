import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { fromNodeSqlite, stmt } from '@agent-jobs/indexer'
import { migrateTelegram } from '../src/telegram.ts'
import { RELAY_ALERT, relayLevel, watchRelay } from '../src/relay-watch.ts'

const relay = '0xac7282b6a519665dcb71563317C71d1F357f9e7e' as const
const owner = '0xb9970a6371358f6c74dfb15a7cb2653e3ae3e471'
const MON = 10n ** 18n

async function setup() {
  const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
  await migrateTelegram(sql)
  await sql.batch([stmt('INSERT INTO telegram_links VALUES (?, ?, ?, NULL, ?)', '42', 10143, owner, 1)])
  return sql
}

describe('relay balance watch', () => {
  it('classifies warning below 3 MON and critical below 2.2 MON', () => {
    expect(relayLevel(4n * MON)).toBe('ok')
    expect(relayLevel(RELAY_ALERT.warnWei - 1n)).toBe('warning')
    expect(relayLevel(RELAY_ALERT.criticalWei - 1n)).toBe('critical')
  })

  it('checks every 10 minutes, alerts the owner on a worse level and repeats hourly while low', async () => {
    const sql = await setup()
    let balance = 5n * MON
    const watch = (now: number, force = false) => watchRelay(sql, { network: 'monad-testnet', now, relay, balance: async () => balance, force })
    expect(await watch(1000)).toMatchObject({ checked: true, level: 'ok', alerted: false })
    balance = 2_240_000_000_000_000_000n
    expect(await watch(1100)).toEqual({ checked: false })
    expect(await watch(1100, true)).toMatchObject({ checked: true, level: 'warning', alerted: true })
    expect(await watch(1800)).toMatchObject({ level: 'warning', alerted: false })
    balance = 2n * MON
    expect(await watch(2400)).toMatchObject({ level: 'critical', alerted: true })
    expect(await watch(3000)).toMatchObject({ level: 'critical', alerted: false })
    expect(await watch(2400 + RELAY_ALERT.repeatSeconds)).toMatchObject({ level: 'critical', alerted: true })
    const sent = await sql.all<{ chat_id: string; text: string }>('SELECT chat_id, text FROM telegram_outbox ORDER BY created_at')
    expect(sent).toHaveLength(3)
    expect(sent.every(row => row.chat_id === '42')).toBe(true)
    expect(sent[0]!.text).toContain('relay warning')
    expect(sent[0]!.text).toContain('2.240 MON')
    expect(sent[1]!.text).toContain('relay critical')
  })

  it('queues one alert when two callers race in the same hour', async () => {
    const sql = await setup()
    const input = { network: 'monad-testnet' as const, now: 7200, relay, balance: async () => 2n * MON, force: true }
    await Promise.all([watchRelay(sql, input), watchRelay(sql, input)])
    expect(await sql.all('SELECT id FROM telegram_outbox')).toHaveLength(1)
  })
})
