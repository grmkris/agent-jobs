import { expect, test } from 'bun:test'
import { computeEpoch, leafValues } from './compute.ts'
import { cumulativeBudget, fundingRemainder, MINING_RESERVE, replayLots, scheduledLot, WEEKLY_BUDGET } from './lots.ts'
import { buildTree } from './tree.ts'
import type { Address, Hex } from './viem.ts'

test('short first epoch, halvings and reserve ceiling match MiningSchedule integer arithmetic', () => {
  expect(scheduledLot(0n)).toBe((WEEKLY_BUDGET * 3n) / 7n)
  for (const epoch of [1n, 26n]) expect(scheduledLot(epoch)).toBe(WEEKLY_BUDGET)
  for (const epoch of [27n, 52n]) expect(scheduledLot(epoch)).toBe(WEEKLY_BUDGET >> 1n)
  expect(scheduledLot(53n)).toBe(WEEKLY_BUDGET >> 2n)
  expect(cumulativeBudget(182n)).toBe(MINING_RESERVE)
  expect(scheduledLot(182n)).toBe(0n)
  expect(replayLots(10n ** 30n, []).available).toBe(0n)
})

test('zero and low funding carry only unspent lots; partial consumption is oldest first', () => {
  const first = scheduledLot(0n)
  const funding = [
    { epoch: 0n, amount: first - 100n },
    { epoch: 2n, amount: 110n },
  ]
  const before = replayLots(2n, funding)
  expect(before.usable.map((lot) => lot.remaining)).toEqual([100n, WEEKLY_BUDGET, WEEKLY_BUDGET])
  expect(before.fundedThis).toBe(110n)
  const after = replayLots(3n, funding)
  expect(after.usable.map((lot) => lot.remaining)).toEqual([0n, WEEKLY_BUDGET - 10n, WEEKLY_BUDGET, WEEKLY_BUDGET])
})

test('a lot survives n+4 and permanently expires at n+5; rollover never becomes a new lot', () => {
  const zero = replayLots(4n, [])
  expect(zero.usable.map((lot) => lot.epoch)).toEqual([0n, 1n, 2n, 3n, 4n])
  const five = replayLots(5n, [])
  expect(five.available).toBe(5n * WEEKLY_BUDGET)
  expect(five.expired[0]?.remaining).toBe(scheduledLot(0n))
  const seven = replayLots(7n, [{ epoch: 0n, amount: 1n }])
  expect(seven.usable.map((lot) => lot.epoch)).toEqual([3n, 4n, 5n, 6n, 7n])
  expect(seven.available).toBe(5n * WEEKLY_BUDGET)
})

test('public funding replay rejects expired, out-of-order, future and excessive sends', () => {
  expect(() => replayLots(6n, [{ epoch: 5n, amount: 5n * WEEKLY_BUDGET + 1n }])).toThrow('live lots')
  expect(() =>
    replayLots(2n, [
      { epoch: 1n, amount: 1n },
      { epoch: 0n, amount: 1n },
    ]),
  ).toThrow('epoch order')
  expect(() => replayLots(0n, [{ epoch: 1n, amount: 1n }])).toThrow('epoch order')
  expect(() => replayLots(0n, [{ epoch: 0n, amount: scheduledLot(0n) + 1n }])).toThrow('live lots')
})

test('partial funding reruns reproduce leaves/root and fund only emission remainder including leaf dust', () => {
  const token = `0x${'1'.repeat(40)}` as Address
  const worker = `0x${'2'.repeat(40)}` as Address
  const creator = `0x${'3'.repeat(40)}` as Address
  const args = {
    fees: [
      {
        block: 1n,
        logIndex: 0,
        tx: `0x${'1'.repeat(64)}` as Hex,
        holding: token,
        jobId: 1n,
        token,
        worker,
        creator,
        amount: 19n,
        bonusPart: 0n,
      },
    ],
    owed: [],
    withdrawals: [],
    prices: { epoch: 0n, tokens: [{ token, decimals: 18, usdPrice: 10n ** 18n }], factoryUsdPrice: 10n ** 18n },
  }
  const original = computeEpoch({ ...args, budget: replayLots(0n, []).available })
  const rerun = computeEpoch({ ...args, budget: replayLots(0n, [{ epoch: 0n, amount: 4n }]).available })
  expect(original.emission).toBe(9n)
  expect(original.total).toBe(8n)
  expect(rerun.leaves).toEqual(original.leaves)
  expect(buildTree(leafValues(0n, rerun.leaves))).toEqual(buildTree(leafValues(0n, original.leaves)))
  expect(fundingRemainder(rerun.emission, 4n)).toBe(5n)
  expect(fundingRemainder(rerun.emission, 9n)).toBe(0n)
  expect(() => fundingRemainder(rerun.emission, 10n)).toThrow('beyond')
})
