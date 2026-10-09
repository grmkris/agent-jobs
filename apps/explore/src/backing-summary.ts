import type { BackedPosition } from './delegation-query.ts'

/** The parts of a backed position the summary reads. */
export interface SummaryEntry {
  position: Pick<BackedPosition['position'], 'account' | 'activeValue' | 'queued' | 'queuedShares' | 'unlockAt'>
  backing: Pick<BackedPosition['backing'], 'assets' | 'reserved' | 'available'>
}

/** The signed-in wallet's SIDE at a glance, across every position it holds. */
export interface BackingSummary {
  /** SIDE in the wallet, free to back with. */
  wallet: bigint
  /** Backing that counts now: behind accounts, not leaving. */
  active: bigint
  /** Leaving and still in its unstake period; `nextUnlock` is the soonest it ends (seconds), or null. */
  leaving: bigint
  nextUnlock: number | null
  /** Unlocked but held while that account's open deposits still need it. */
  held: bigint
  /** Unlocked and free: withdraw it to the wallet. */
  ready: bigint
  /** Reserved from the wallet's own backing by its open jobs (requester deposits). */
  reservedOwn: bigint
  /** Backing of the wallet's own account not yet reserved: what new jobs can put at risk. */
  freeOwn: bigint
}

export function backingSummary(
  positions: readonly SummaryEntry[],
  wallet: bigint,
  owner: string,
  now: number,
): BackingSummary {
  const summary: BackingSummary = {
    wallet,
    active: 0n,
    leaving: 0n,
    nextUnlock: null,
    held: 0n,
    ready: 0n,
    reservedOwn: 0n,
    freeOwn: 0n,
  }
  for (const { position, backing } of positions) {
    summary.active += position.activeValue
    if (position.account.toLowerCase() === owner.toLowerCase()) {
      summary.reservedOwn = backing.reserved
      summary.freeOwn = backing.available
    }
    if (position.queuedShares === 0n) continue
    if (position.unlockAt > now) {
      summary.leaving += position.queued
      summary.nextUnlock =
        summary.nextUnlock === null ? position.unlockAt : Math.min(summary.nextUnlock, position.unlockAt)
    } else if (backing.assets - position.queued < backing.reserved) summary.held += position.queued
    else summary.ready += position.queued
  }
  return summary
}
