import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { fromNodeSqlite, stmt } from '@sidequest/indexer'
import { migrateTelegram } from '../src/telegram.ts'
import { RELAY_ALERT, relayLevel, reportRelayWatchFailure, watchRelay } from '../src/relay-watch.ts'

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

  it('queues one owner alert per level per hour from every caller, with no state table of its own', async () => {
    const sql = await setup()
    let balance = 5n * MON
    const watch = (now: number) =>
      watchRelay(sql, { network: 'monad-testnet', now, relay, balance: async () => balance })
    expect(await watch(3600)).toMatchObject({ level: 'ok', queued: false })
    balance = 2_240_000_000_000_000_000n
    await Promise.all([watch(3660), watch(3660), watch(4000)])
    balance = 2n * MON
    await watch(4100)
    await watch(5000)
    await watch(3600 + RELAY_ALERT.repeatSeconds)
    const sent = await sql.all<{ chat_id: string; text: string }>(
      'SELECT chat_id, text FROM telegram_outbox ORDER BY rowid',
    )
    expect(sent.map((row) => row.text.match(/relay (\w+)/)?.[1])).toEqual(['warning', 'critical', 'critical'])
    expect(sent.every((row) => row.chat_id === '42')).toBe(true)
    expect(sent[0]!.text).toContain('2.240 MON')
    const tables = await sql.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'telegram_%'",
    )
    expect(tables).toEqual([])
  })

  it('logs a failed balance read without any message or body text', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      reportRelayWatchFailure(
        Object.assign(new Error('fetch https://rpc.monad.example/key/ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 failed'), {
          name: 'HttpRequestError',
          status: 401,
        }),
      )
      reportRelayWatchFailure(new Error('Authorization: Bearer SECRETKEY'))
      reportRelayWatchFailure(Object.assign(new Error('rpc refused'), { body: '{"apiKey":"short-secret"}' }))
      const logged = spy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(logged).toContain('relay-watch-failed')
      expect(logged).toContain('"status":401')
      expect(logged).not.toMatch(/rpc\.monad\.example|ABCDEFGHIJ|Bearer|SECRETKEY|short-secret|apiKey|refused/)
    } finally {
      spy.mockRestore()
    }
  })
})
