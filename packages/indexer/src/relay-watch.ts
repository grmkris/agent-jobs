import { errorDiagnostics } from '@sidequest/board'
import type { AsyncSql } from './store.ts'
import type { Network } from '@sidequest/sdk'
import { type Address, formatEther } from 'viem'
import { enqueueWalletNotification, telegramOwnerWallets, telegramSite } from './telegram.ts'

/** The relay refuses sponsored sends below 2 MON plus the send's cost (sponsorRelayFloor); warn well before that. */
export const RELAY_ALERT = { warnWei: 3n * 10n ** 18n, criticalWei: 22n * 10n ** 17n, repeatSeconds: 3600 } as const

export type RelayLevel = 'ok' | 'warning' | 'critical'
export const relayLevel = (balance: bigint): RelayLevel => balance < RELAY_ALERT.criticalWei ? 'critical' : balance < RELAY_ALERT.warnWei ? 'warning' : 'ok'

export interface RelayWatchResult { readonly level: RelayLevel; readonly balance: string; readonly queued: boolean }

/**
 * Reads the relay balance and, below the warning level, queues an owner Telegram alert. The outbox id is per
 * network, level, hour and wallet and the outbox ignores duplicates, so the indexer's minute cron and a floor
 * refusal together send at most one alert per level per hour, with no state table of their own.
 */
export async function watchRelay(sql: AsyncSql, input: { network: Network; now: number; relay: Address; balance: () => Promise<bigint> }): Promise<RelayWatchResult> {
  const balance = await input.balance()
  const level = relayLevel(balance)
  if (level === 'ok') return { level, balance: balance.toString(), queued: false }
  const text = `<b>Sidequest relay ${level}</b> (${input.network}): ${Number(formatEther(balance)).toFixed(3)} MON at ${input.relay}. `
    + `Sponsored agent actions refuse below 2 MON plus the send cost. Top up per docs/sponsorship.md (Relay funding). ${telegramSite(input.network)}`
  const id = `relay:${input.network}:${level}:${Math.floor(input.now / RELAY_ALERT.repeatSeconds)}`
  for (const wallet of telegramOwnerWallets(input.network)) await enqueueWalletNotification(sql, input.network, wallet, { id: `${id}:${wallet.toLowerCase()}`, text, now: input.now })
  return { level, balance: balance.toString(), queued: true }
}

/** A failed balance check never fails its caller; log bounded diagnostics only (no RPC URL, key or body). */
export function reportRelayWatchFailure(error: unknown): void {
  console.error(JSON.stringify({ event: 'relay-watch-failed', ...errorDiagnostics(error) }))
}
