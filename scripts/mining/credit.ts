import type { FeeCharged, LogPosition } from './compute.ts'
import { V2_RULE } from './rule.ts'
import type { Address } from './viem.ts'

export interface ChainPosition {
  block: bigint
  logIndex: number
}

export interface FeeSchedule {
  thresholds: readonly bigint[]
  bps: readonly bigint[]
  treasury: Address
}

export interface ScheduleRecord extends FeeSchedule, ChainPosition {}

export interface ActivationRecord extends LogPosition {
  jobId: bigint
  worker: Address
  agentId: bigint
  feeBps: bigint
  fee: bigint
  net: bigint
}

export const chainOrder = (a: ChainPosition, b: ChainPosition) =>
  a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1

/** V2 requires four distinct ranks, including a nonzero lowest rate. */
export function validateScheduleV2(schedule: FeeSchedule): void {
  if (schedule.thresholds.length !== 4 || schedule.bps.length !== 4)
    throw new Error('v2 fee schedule must have four tiers')
  if (schedule.thresholds[0] !== 0n) throw new Error('v2 fee schedule first threshold must be zero')
  if (schedule.treasury.toLowerCase() === '0x0000000000000000000000000000000000000000')
    throw new Error('v2 fee schedule treasury must not be zero')
  for (let i = 1; i < 4; i++) {
    if (schedule.thresholds[i]! <= schedule.thresholds[i - 1]!)
      throw new Error('v2 fee schedule thresholds must be strictly ascending')
    if (schedule.bps[i]! >= schedule.bps[i - 1]!) throw new Error('v2 fee schedule bps must be strictly descending')
  }
  if (schedule.bps[3]! < 1n) throw new Error('v2 fee schedule lowest bps must be at least one')
}

export function scheduleAt(history: readonly ScheduleRecord[], position: ChainPosition): ScheduleRecord {
  const schedule = history
    .filter((set) => chainOrder(set, position) <= 0)
    .toSorted(chainOrder)
    .at(-1)
  if (schedule === undefined) throw new Error('missing fee schedule history')
  validateScheduleV2(schedule)
  return schedule
}

export function rankOfStake(stake: bigint, schedule: FeeSchedule): number {
  validateScheduleV2(schedule)
  if (stake < 0n) throw new Error('stake must not be negative')
  return schedule.thresholds.findLastIndex((threshold) => stake >= threshold)
}

export function rankOfFeeBps(feeBps: bigint, schedule: FeeSchedule): number {
  validateScheduleV2(schedule)
  const rank = schedule.bps.indexOf(feeBps)
  if (rank === -1) throw new Error('unknown activation feeBps')
  return rank
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n)
    throw new Error('ceilDiv requires a nonnegative numerator and positive divisor')
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n
}

/** Base fees are capped by _quote; bonus fees round up independently without that cap. */
export function checkFee(fee: FeeCharged, activation: ActivationRecord, bonus: bigint): void {
  if (
    fee.holding.toLowerCase() !== activation.holding.toLowerCase() ||
    fee.worker.toLowerCase() !== activation.worker.toLowerCase()
  )
    throw new Error('fee and activation worker or holding disagree')
  if (fee.jobId !== activation.jobId || chainOrder(activation, fee) >= 0)
    throw new Error('fee has no matching earlier activation')
  if (fee.amount < 0n || fee.bonusPart < 0n || bonus < 0n || activation.fee < 0n || activation.net <= 0n)
    throw new Error('invalid fee or activation amounts')
  if (fee.amount - fee.bonusPart !== activation.fee) throw new Error('fee base disagrees with activation')
  if (fee.bonusPart !== ceilDiv(bonus * activation.feeBps, 10000n))
    throw new Error('bonus fee disagrees with contract rounding')
  const reward = activation.fee + activation.net
  const quoted = ceilDiv(reward * activation.feeBps, 10000n)
  if (activation.fee !== (quoted < reward ? quoted : reward - 1n))
    throw new Error('activation fee disagrees with contract rounding')
}

/** The held rank uses the activation's schedule, even when a later schedule changes the same stake's tier. */
export function creditOf(input: {
  fee: FeeCharged
  activation: ActivationRecord
  bonus: bigint
  schedule: FeeSchedule
  heldStake: bigint
}) {
  const { fee, activation, bonus, schedule, heldStake } = input
  checkFee(fee, activation, bonus)
  const activationRank = rankOfFeeBps(activation.feeBps, schedule)
  const heldRank = rankOfStake(heldStake, schedule)
  const rank = Math.min(activationRank, heldRank)
  const boostBps = V2_RULE.boostBps[rank]
  if (boostBps === undefined) throw new Error('invalid credit rank')
  const gross = activation.fee + activation.net + bonus
  const lowestBps = schedule.bps[3]!
  const uncappedCredit = (gross * lowestBps * boostBps) / 100_000_000n
  const credit = uncappedCredit < fee.amount ? uncappedCredit : fee.amount
  return {
    gross,
    bonus,
    feeBps: activation.feeBps,
    activationRank,
    heldStake,
    heldRank,
    rank,
    lowestBps,
    boostBps,
    uncappedCredit,
    amount: fee.amount,
    credit,
  }
}
