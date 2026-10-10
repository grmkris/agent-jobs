import { expect, test } from 'bun:test'
import { computeEpochV2, type EpochInputV2, type WorkerStake } from './compute-v2.ts'
import { ceilDiv, type ActivationRecord, type ScheduleRecord } from './credit.ts'
import type { BackerPositionInput, FeeCharged, PayoutOwed } from './compute.ts'
import type { PriceList } from './prices.ts'
import type { Address } from './viem.ts'

const worker = '0x0000000000000000000000000000000000000001'
const other = '0x0000000000000000000000000000000000000002'
const creator = '0x0000000000000000000000000000000000000003'
const backer = '0x0000000000000000000000000000000000000004'
const holding = '0x0000000000000000000000000000000000000005'
const token = '0x0000000000000000000000000000000000000006'
const treasury = '0x0000000000000000000000000000000000000007'
const tx = `0x${'22'.repeat(32)}` as const
const side = 10n ** 18n
const schedule: ScheduleRecord = {
  block: 1n,
  logIndex: 0,
  thresholds: [0n, 10_000n * side, 100_000n * side, 1_000_000n * side],
  bps: [3000n, 1000n, 300n, 100n],
  treasury,
}
const prices: PriceList = { epoch: 30n, tokens: [{ token, decimals: 6, usdPrice: side }], factoryUsdPrice: 10n ** 15n }
function row(rank = 3, jobId = 1n, account: Address = worker, reward = 100_000_000n) {
  const feeBps = schedule.bps[rank] ?? 100n
  const baseFee = ceilDiv(reward * feeBps, 10000n)
  const activation: ActivationRecord = {
    block: 2n,
    logIndex: Number(jobId),
    tx,
    holding,
    jobId,
    worker: account,
    agentId: jobId,
    feeBps,
    fee: baseFee,
    net: reward - baseFee,
  }
  const fee: FeeCharged = {
    block: 10n,
    logIndex: Number(jobId),
    tx,
    holding,
    jobId,
    token,
    worker: account,
    creator,
    amount: baseFee,
    bonusPart: 0n,
  }
  const stake: WorkerStake = {
    worker: account,
    start: schedule.thresholds[rank] ?? 0n,
    end: schedule.thresholds[rank] ?? 0n,
  }
  return { activation, fee, stake }
}
function base(rows = [row()]): EpochInputV2 {
  return {
    fees: rows.map((r) => r.fee),
    activations: rows.map((r) => r.activation),
    schedules: [schedule],
    stakes: rows.map((r) => r.stake),
    owed: [],
    withdrawals: [],
    prices,
    budget: 10n ** 30n,
  }
}
const position = (delegator: Address, weight: bigint): BackerPositionInput => ({
  account: worker,
  delegator,
  start: weight,
  end: weight,
  weight,
})
const leafAmount = (result: ReturnType<typeof computeEpochV2>, account: Address) =>
  result.leaves.find((leaf) => leaf.account === account)?.amount ?? 0n

test('the $100-job table credits 0.40, 0.60, 0.80 and 1.00 USD', () => {
  const results = [0, 1, 2, 3].map((rank) => computeEpochV2(base([row(rank)])))
  expect(results.map((result) => result.fees[0]?.credit?.credit)).toEqual([400_000n, 600_000n, 800_000n, 1_000_000n])
  expect(results.map((result) => result.fees[0]?.credit?.usd)).toEqual([
    4n * 10n ** 17n,
    6n * 10n ** 17n,
    8n * 10n ** 17n,
    side,
  ])
  expect(results.reduce((sum, result) => sum + result.creditUsd, 0n)).toBe(28n * 10n ** 17n)
  expect(results.map((result) => result.fees[0]?.usd)).toEqual([30n * side, 10n * side, 3n * side, side])
  expect(results.map((result) => result.feeUsd)).toEqual([30n * side, 10n * side, 3n * side, side])
  expect(results.reduce((sum, result) => sum + result.demand, 0n)).toBe(1400n * side)
})

test('60/40 pools are pro rata by credit USD, with exact total = sum of leaves', () => {
  const result = computeEpochV2(base([row(3, 1n), row(3, 2n, other, 200_000_000n)]))
  expect(result.leaves).toEqual([
    { account: worker, amount: 300n * side },
    { account: other, amount: 600n * side },
    { account: creator, amount: 600n * side },
  ])
  expect(result.total).toBe(1500n * side)
  expect(result.total).toBe(result.leaves.reduce((sum, leaf) => sum + leaf.amount, 0n))
})

test('contributors split bonus credit through unchanged creatorWeights', () => {
  const r = row()
  const topUps = [
    { block: 3n, logIndex: 0, tx, holding, jobId: 1n, contributor: other, amount: 5_000_000n, bonus: 5_000_000n },
    { block: 4n, logIndex: 0, tx, holding, jobId: 1n, contributor: backer, amount: 15_000_000n, bonus: 20_000_000n },
    { block: 11n, logIndex: 0, tx, holding, jobId: 1n, contributor: backer, amount: 80_000_000n, bonus: 100_000_000n },
  ]
  const input = { ...base([r]), fees: [{ ...r.fee, amount: 1_200_000n, bonusPart: 200_000n }], topUps }
  const result = computeEpochV2(input)
  expect(result.fees[0]?.credit).toMatchObject({ bonus: 20_000_000n, gross: 120_000_000n, credit: 1_200_000n })
  expect(result.leaves).toEqual([
    { account: worker, amount: 360n * side },
    { account: other, amount: 10n * side },
    { account: creator, amount: 200n * side },
    { account: backer, amount: 30n * side },
  ])
  expect(() => computeEpochV2({ ...input, topUps: topUps.slice(1) })).toThrow('contribution history')
})

test('the smaller stake endpoint bounds borrowed backing', () => {
  const result = computeEpochV2({ ...base([row(1)]), stakes: [{ worker, start: 10_000n * side, end: 0n }] })
  expect(result.fees[0]?.credit).toMatchObject({ activationRank: 1, heldRank: 0, boostBps: 4000n })
  expect(result.creditUsd).toBe(4n * 10n ** 17n)
})

test('a one-wei position and weights below 100 SIDE have no recorded row or payment', () => {
  const input = base()
  const result = computeEpochV2({
    ...input,
    backerWorkers: [
      { worker, agentId: 1n, bps: 10000n, positions: [position(backer, 1n), position(other, 100n * side - 1n)] },
    ],
  })
  expect(result.backerPositions).toEqual([])
  expect(result.leaves).toEqual(computeEpochV2(input).leaves)
})

test('weights at 100 SIDE count, and backer payments below 1 SIDE stay with worker', () => {
  const result = computeEpochV2({
    ...base(),
    backerWorkers: [{ worker, agentId: 1n, bps: 1n, positions: [position(backer, 100n * side)] }],
  })
  expect(result.backerPositions).toEqual([position(backer, 100n * side)])
  expect(leafAmount(result, backer)).toBe(0n)
  expect(leafAmount(result, worker)).toBe(300n * side)
})

test('accepted backer payments split only qualified weights, with remainder left to worker', () => {
  const result = computeEpochV2({
    ...base(),
    backerWorkers: [
      {
        worker,
        agentId: 1n,
        bps: 10000n,
        positions: [position(backer, 100n * side), position(other, 700n * side), position(creator, 1n)],
      },
    ],
  })
  expect(result.backerPositions).toEqual([position(other, 700n * side), position(backer, 100n * side)])
  expect(leafAmount(result, backer)).toBe((375n * side) / 10n)
  expect(leafAmount(result, other)).toBe((2625n * side) / 10n)
  expect(result.total).toBe(500n * side)
})

test('payment exactly 1 SIDE counts', () => {
  const result = computeEpochV2({
    ...base(),
    budget: 2n * side,
    backerWorkers: [
      { worker, agentId: 1n, bps: 10000n, positions: [position(backer, 500n * side), position(other, 100n * side)] },
    ],
  })
  expect(leafAmount(result, backer)).toBe(side)
  expect(leafAmount(result, other)).toBe(0n)
})

test('merged leaves below 1 SIDE are dropped and stay in reserve', () => {
  const result = computeEpochV2({ ...base(), budget: side })
  expect(result.emission).toBe(side)
  expect(result.leaves).toEqual([])
  expect(result.total).toBe(0n)
})

test('roles merge before the leaf floor, including a wallet that created and worked', () => {
  const r = row()
  const result = computeEpochV2({ ...base([r]), fees: [{ ...r.fee, creator: worker }], budget: side })
  expect(result.leaves).toEqual([{ account: worker, amount: side }])
  expect(result.total).toBe(side)
})

test('unpriced fees and treasury-owed fees do not require credit history; later withdrawal counts', () => {
  const r = row()
  expect(
    computeEpochV2({ ...base(), fees: [{ ...r.fee, token: other }], activations: [], stakes: [] }).fees[0]?.status,
  ).toBe('unpriced')
  const owed: PayoutOwed = { ...r.fee, logIndex: 2, to: treasury, amount: r.fee.amount }
  const input = { ...base(), owed: [owed] }
  expect(computeEpochV2({ ...input, activations: [], stakes: [] }).fees[0]?.status).toBe('owed-to-treasury')
  const withdrawal = { ...owed, block: 11n }
  expect(computeEpochV2({ ...input, withdrawals: [withdrawal] }).total).toBe(500n * side)
  expect(computeEpochV2({ ...input, withdrawals: [{ ...withdrawal, block: 9n }] }).total).toBe(0n)
})

test('counted fees refuse missing or mismatched activation and missing stake endpoints', () => {
  const input = base()
  expect(() => computeEpochV2({ ...input, activations: [] })).toThrow('activation')
  expect(() => computeEpochV2({ ...input, stakes: [] })).toThrow('stake endpoints')
  expect(() => computeEpochV2({ ...input, activations: [{ ...row().activation, worker: other }] })).toThrow(
    'worker or holding',
  )
})

test('budget caps emission and a low SIDE reference uses the existing floor', () => {
  expect(computeEpochV2({ ...base(), budget: 10n * side }).emission).toBe(10n * side)
  const result = computeEpochV2({ ...base(), prices: { ...prices, factoryUsdPrice: 1n } })
  expect(result.factoryUsdPrice).toBe(10n ** 14n)
  expect(result.demand).toBe(5000n * side)
  expect(computeEpochV2({ ...base(), fees: [], activations: [], stakes: [] }).total).toBe(0n)
})
