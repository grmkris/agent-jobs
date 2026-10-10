import { expect, test } from 'bun:test'
import {
  ceilDiv,
  checkFee,
  creditOf,
  rankOfFeeBps,
  rankOfStake,
  scheduleAt,
  validateScheduleV2,
  type ActivationRecord,
  type FeeSchedule,
} from './credit.ts'
import type { FeeCharged } from './compute.ts'

const worker = '0x0000000000000000000000000000000000000001'
const holding = '0x0000000000000000000000000000000000000002'
const creator = '0x0000000000000000000000000000000000000003'
const tx = `0x${'11'.repeat(32)}` as const
const side = 10n ** 18n
const schedule: FeeSchedule = {
  thresholds: [0n, 10_000n * side, 100_000n * side, 1_000_000n * side],
  bps: [3000n, 1000n, 300n, 100n],
  treasury: creator,
}
const activated = (feeBps = 1000n, reward = 100_000_000n): ActivationRecord => {
  const quoted = ceilDiv(reward * feeBps, 10000n)
  const fee = quoted < reward ? quoted : reward - 1n
  return { block: 2n, logIndex: 0, tx, holding, worker, agentId: 1n, jobId: 1n, feeBps, fee, net: reward - fee }
}
const charged = (activation: ActivationRecord, bonus = 0n): FeeCharged => {
  const bonusPart = ceilDiv(bonus * activation.feeBps, 10000n)
  return {
    block: 3n,
    logIndex: 1,
    tx,
    holding,
    worker,
    creator,
    jobId: 1n,
    token: holding,
    amount: activation.fee + bonusPart,
    bonusPart,
  }
}

test('every threshold is inclusive, including 9999.99 versus 10000 SIDE', () => {
  expect(rankOfStake((999_999n * side) / 100n, schedule)).toBe(0)
  for (const [rank, threshold] of schedule.thresholds.entries()) {
    expect(rankOfStake(threshold, schedule)).toBe(rank)
    if (threshold > 0n) expect(rankOfStake(threshold - 1n, schedule)).toBe(rank - 1)
    expect(rankOfStake(threshold + 1n, schedule)).toBe(rank)
  }
  expect(() => rankOfStake(-1n, schedule)).toThrow('negative')
})

test('100-dollar jobs credit 0.40, 0.60, 0.80 and 1.00 dollars', () => {
  for (const [rank, feeBps] of schedule.bps.entries()) {
    const activation = activated(feeBps)
    const result = creditOf({
      fee: charged(activation),
      activation,
      bonus: 0n,
      schedule,
      heldStake: schedule.thresholds[rank] ?? 0n,
    })
    expect(result).toMatchObject({
      gross: 100_000_000n,
      rank,
      credit: [400_000n, 600_000n, 800_000n, 1_000_000n][rank],
    })
  }
})

test('borrowed activation backing cannot raise the boost held through the epoch', () => {
  const activation = activated()
  expect(creditOf({ fee: charged(activation), activation, bonus: 0n, schedule, heldStake: 0n })).toMatchObject({
    activationRank: 1,
    heldRank: 0,
    rank: 0,
    boostBps: 4000n,
    credit: 400_000n,
  })
})

test('scheduleAt uses the last executed schedule by block/log index and preserves old activations', () => {
  const old = { ...schedule, block: 1n, logIndex: 0 }
  const changed = { ...schedule, bps: [2000n, 900n, 250n, 50n], block: 2n, logIndex: 1 }
  const history = [changed, old]
  expect(scheduleAt(history, { block: 2n, logIndex: 0 })).toBe(old)
  const selected = scheduleAt(history, { block: 2n, logIndex: 2 })
  expect(selected).toBe(changed)
  const activation = { ...activated(900n), logIndex: 2 }
  expect(
    creditOf({ fee: charged(activation), activation, bonus: 0n, schedule: selected, heldStake: 10_000n * side }).credit,
  ).toBe(300_000n)
  expect(() => scheduleAt(history, { block: 0n, logIndex: 0 })).toThrow('missing')
})

test('degenerate schedules and unknown activation rates refuse', () => {
  const invalid = [
    { ...schedule, thresholds: [1n, 2n, 3n, 4n] },
    { ...schedule, thresholds: [0n, 1n, 1n, 2n] },
    { ...schedule, thresholds: [0n, 1n, 2n] },
    { ...schedule, bps: [3000n, 1000n, 1000n, 100n] },
    { ...schedule, bps: [3000n, 1000n, 300n, 0n] },
    { ...schedule, bps: [3000n, 1000n, 300n, -1n] },
    { ...schedule, treasury: '0x0000000000000000000000000000000000000000' as const },
  ]
  for (const s of invalid) expect(() => validateScheduleV2(s)).toThrow('v2 fee schedule')
  expect(() => rankOfFeeBps(999n, schedule)).toThrow('unknown')
})

test('ceilDiv matches the contract mulDiv rounding at exact and nonexact boundaries', () => {
  for (const numerator of [0n, 1n, 9999n, 10000n, 10001n, 123456789123456789123456789n]) {
    const result = ceilDiv(numerator, 10000n)
    expect(result * 10000n >= numerator).toBe(true)
    if (result > 0n) expect((result - 1n) * 10000n < numerator).toBe(true)
  }
  expect(() => ceilDiv(-1n, 1n)).toThrow()
  expect(() => ceilDiv(1n, 0n)).toThrow()
})

test('checkFee cross-checks bonus rounding, base snapshot and worker/holding/job identity', () => {
  const activation = activated(300n, 101n)
  const fee = charged(activation, 101n)
  expect(fee).toMatchObject({ amount: 8n, bonusPart: 4n })
  expect(() => checkFee(fee, activation, 101n)).not.toThrow()
  for (const patch of [
    { amount: 7n },
    { bonusPart: 3n, amount: 7n },
    { holding: creator },
    { worker: creator },
    { jobId: 2n },
    { block: 1n },
  ])
    expect(() => checkFee({ ...fee, ...patch }, activation, 101n)).toThrow()
  expect(() => checkFee(fee, { ...activation, fee: 3n, net: 98n }, 101n)).toThrow('base')
  expect(() => checkFee(fee, { ...activation, fee: 4n, net: 200n }, 101n)).toThrow('rounding')
})

test('base fee caps at reward minus one while a one-unit bonus rounds without a cap', () => {
  const activation = activated(100n, 1n)
  expect(activation).toMatchObject({ fee: 0n, net: 1n })
  expect(() => checkFee(charged(activation, 1n), activation, 1n)).not.toThrow()
  expect(charged(activation, 1n).bonusPart).toBe(1n)
})

test('a hypothetical sub-one-percent schedule still caps credit at the actual paid fee', () => {
  const tiny = { ...schedule, bps: [30n, 20n, 10n, 1n] }
  const activation = activated(1n, 1n)
  const result = creditOf({
    fee: charged(activation),
    activation,
    bonus: 0n,
    schedule: tiny,
    heldStake: 1_000_000n * side,
  })
  expect(result.credit <= result.amount).toBe(true)
  expect(result.credit).toBe(0n)
})
