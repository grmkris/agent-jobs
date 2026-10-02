/**
 * Staking as people read it (ADR-0011): which fee tier a stake falls in and what the next one takes, from the
 * FeeSchedule's own thresholds and rates (never hard-coded), and the amounts a person types, checked before any
 * signature. Pure, so it is unit-tested (stake.test.ts).
 */
import { parseUnits } from 'viem'

/** The schedule in force, as `FeeSchedule.schedule()` returns it: thresholds in FACTORY wei, rates in basis points. */
export interface FeeSchedule {
  thresholds: readonly bigint[]
  bps: readonly number[]
}

export interface Tier {
  index: number
  bps: number
  threshold: bigint
}

/** The tier `stake` (wei, reservations included) is in, and the next lower-fee tier with how much more it needs. */
export function tierOf(schedule: FeeSchedule, stake: bigint): { current: Tier; next: (Tier & { needed: bigint }) | null } {
  let index = 0
  schedule.thresholds.forEach((threshold, i) => {
    if (stake >= threshold) index = i
  })
  const at = (i: number): Tier => ({ index: i, bps: schedule.bps[i] ?? 0, threshold: schedule.thresholds[i] ?? 0n })
  const after = index + 1 < schedule.thresholds.length ? at(index + 1) : null
  return { current: at(index), next: after === null ? null : { ...after, needed: after.threshold - stake } }
}

/** "10 %", "2.5 %": a rate in basis points. */
export const percent = (bps: number) => `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} %`

/** A FACTORY amount typed by a person, in wei; null when it is not a positive amount with at most 18 decimals. */
export function factoryAmount(text: string): bigint | null {
  const t = text.trim()
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null
  const [, frac = ''] = t.split('.')
  if (frac.length > 18) return null
  const wei = parseUnits(t, 18)
  return wei > 0n ? wei : null
}

/** Why `amount` cannot be staked or unstaked now, in words; null when it can. */
export function amountProblem(text: string, limit: bigint | undefined, what: 'stake' | 'unstake'): string | null {
  if (text.trim() === '') return null
  const wei = factoryAmount(text)
  if (wei === null) return 'Enter an amount of FACTORY above zero.'
  if (limit === undefined) return null
  if (wei > limit) return what === 'stake' ? 'That is more FACTORY than your wallet holds.' : 'That is more than you can unstake: reserved stake stays until its jobs settle.'
  return null
}

/**
 * A timelocked proposal (a fee schedule, a Holding): still waiting for its eta, executable for `grace` seconds after
 * it (the contract's own `PROPOSAL_GRACE()`), then expired and refused by the contract.
 */
export function proposalState(eta: number, now: number, grace: number): 'waiting' | 'open' | 'expired' {
  if (now < eta) return 'waiting'
  return now > eta + grace ? 'expired' : 'open'
}
