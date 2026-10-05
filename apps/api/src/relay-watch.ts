import type { AsyncSql } from '@agent-jobs/indexer'
import { stmt } from '@agent-jobs/indexer'
import type { Network } from '@agent-jobs/sdk'
import { type Address, formatEther } from 'viem'
import { enqueueWalletNotification, telegramOwnerWallets, telegramSite } from './telegram.ts'

/** The relay refuses sponsored sends below 2 MON plus the send's cost (sponsorRelayFloor); warn well before that. */
export const RELAY_ALERT = { warnWei: 3n * 10n ** 18n, criticalWei: 22n * 10n ** 17n, checkEverySeconds: 600, repeatSeconds: 3600 } as const

export type RelayLevel = 'ok' | 'warning' | 'critical'
export const relayLevel = (balance: bigint): RelayLevel => balance < RELAY_ALERT.criticalWei ? 'critical' : balance < RELAY_ALERT.warnWei ? 'warning' : 'ok'

const SCHEMA = 'CREATE TABLE IF NOT EXISTS ops_watch (name TEXT PRIMARY KEY, checked_at INTEGER NOT NULL, level TEXT NOT NULL, alerted_at INTEGER)'

export interface RelayWatchResult { readonly checked: boolean; readonly level?: RelayLevel; readonly balance?: string; readonly alerted?: boolean }

/**
 * Reads the relay balance at most every 10 minutes (`force` skips the wait, e.g. after a floor refusal) and queues an
 * owner Telegram alert when the level gets worse or stays low for an hour. The outbox id is per network, level and
 * hour, so concurrent callers queue one message.
 */
export async function watchRelay(sql: AsyncSql, input: { network: Network; now: number; relay: Address; balance: () => Promise<bigint>; force?: boolean }): Promise<RelayWatchResult> {
  await sql.batch([stmt(SCHEMA)])
  const name = `relay:${input.network}`
  const [row] = await sql.all<{ checked_at: number; level: RelayLevel; alerted_at: number | null }>('SELECT checked_at, level, alerted_at FROM ops_watch WHERE name = ?', name)
  if (input.force !== true && row !== undefined && input.now - row.checked_at < RELAY_ALERT.checkEverySeconds) return { checked: false }
  const balance = await input.balance()
  const level = relayLevel(balance)
  const alert = level !== 'ok' && (row?.level !== level || input.now - (row?.alerted_at ?? 0) >= RELAY_ALERT.repeatSeconds)
  if (alert) {
    const text = `<b>Hireling relay ${level}</b> (${input.network}): ${Number(formatEther(balance)).toFixed(3)} MON at ${input.relay}. `
      + `Sponsored agent actions refuse below 2 MON plus the send cost. Top up per docs/sponsorship.md (Relay funding). ${telegramSite(input.network)}`
    const id = `relay:${input.network}:${level}:${Math.floor(input.now / RELAY_ALERT.repeatSeconds)}`
    for (const wallet of telegramOwnerWallets(input.network)) await enqueueWalletNotification(sql, input.network, wallet, { id: `${id}:${wallet.toLowerCase()}`, text, now: input.now })
  }
  await sql.batch([stmt('INSERT OR REPLACE INTO ops_watch (name, checked_at, level, alerted_at) VALUES (?, ?, ?, ?)', name, input.now, level, alert ? input.now : row?.alerted_at ?? null)])
  return { checked: true, level, balance: balance.toString(), alerted: alert }
}
