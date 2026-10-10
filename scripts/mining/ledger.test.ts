import { expect, test } from 'bun:test'
import {
  MiningLedger,
  replayLedger,
  type ActivationEvent,
  type LedgerRecord,
  type ScheduleExecutedRecord,
  type VaultRecord,
} from './ledger.ts'
import type { FeeCharged } from './compute.ts'

const account = '0x0000000000000000000000000000000000000001'
const delegator = '0x0000000000000000000000000000000000000002'
const other = '0x0000000000000000000000000000000000000003'
const holding = '0x0000000000000000000000000000000000000004'
const tx = `0x${'11'.repeat(32)}` as const
const side = 10n ** 18n
const schedule: ScheduleExecutedRecord = {
  block: 1n,
  logIndex: 0,
  eventName: 'ScheduleExecuted',
  thresholds: [0n, 10000n * side, 100000n * side, 1000000n * side],
  bps: [3000n, 1000n, 300n, 100n],
  treasury: holding,
}
const activation: ActivationEvent = {
  eventName: 'Activated',
  block: 3n,
  logIndex: 1,
  tx,
  holding,
  worker: account,
  agentId: 1n,
  jobId: 1n,
  feeBps: 1000n,
  fee: 10n,
  net: 90n,
}
const deposit = (block: bigint, assets: bigint, shares = assets, backer = delegator): VaultRecord => ({
  eventName: 'Delegated',
  account,
  delegator: backer,
  assets,
  shares,
  block,
  logIndex: 0,
})
const queue = (block: bigint, shares: bigint, queuedShares: bigint, assets = shares): VaultRecord => ({
  eventName: 'UndelegateRequested',
  account,
  delegator,
  shares,
  queuedShares,
  assets,
  block,
  logIndex: 0,
})

test('partial queue increments pool queue while the position uses its total', () => {
  const ledger = replayLedger(
    [deposit(1n, 100n), deposit(2n, 50n, 50n, other), queue(3n, 20n, 20n), queue(4n, 30n, 50n)].toReversed(),
  )
  expect(ledger.poolOf(account)).toEqual({ assets: 150n, shares: 150n, queued: 50n, generation: 0n })
  expect(ledger.positionOf(account, delegator)).toMatchObject({ shares: 100n, queued: 50n })
  expect(ledger.stakeOf(account)).toBe(100n)
  expect(ledger.activeShares(account, delegator)).toBe(50n)
  expect(ledger.activeShares(account, other)).toBe(50n)
})

test('cancelling and withdrawing affect only the whole queued position', () => {
  const ledger = replayLedger([deposit(1n, 100n), queue(2n, 20n, 20n)])
  ledger.apply({
    eventName: 'UndelegateCancelled',
    block: 3n,
    logIndex: 0,
    account,
    delegator,
    shares: 20n,
    assets: 20n,
  })
  expect(ledger.stakeOf(account)).toBe(100n)
  ledger.apply(queue(4n, 30n, 30n))
  ledger.apply({ eventName: 'Withdrawn', block: 5n, logIndex: 0, account, delegator, shares: 30n, assets: 30n })
  expect(ledger.poolOf(account)).toEqual({ assets: 70n, shares: 70n, queued: 0n, generation: 0n })
  expect(ledger.positionOf(account, delegator)).toMatchObject({ shares: 70n, queued: 0n })
})

test('slash and forfeiture change assets, and exact stakeOf floors queued share value', () => {
  const ledger = replayLedger([
    deposit(1n, 101n),
    queue(2n, 30n, 30n),
    { eventName: 'Slashed', block: 3n, logIndex: 0, account, amount: 7n },
    { eventName: 'Forfeited', block: 4n, logIndex: 0, account, amount: 5n },
  ])
  expect(ledger.poolOf(account)).toEqual({ assets: 89n, shares: 101n, queued: 30n, generation: 0n })
  expect(ledger.stakeOf(account)).toBe(62n) // floor(71 * 89 / 101)
  expect(ledger.activeShares(account, delegator)).toBe(71n)
  expect(ledger.snapshot().positions.values().next().value?.active).toBe(71n)
})

test('a full slash resets all positions; deposits in the new generation start from zero', () => {
  const ledger = replayLedger([
    deposit(1n, 100n),
    deposit(2n, 50n, 50n, other),
    queue(3n, 20n, 20n),
    { eventName: 'Slashed', block: 4n, logIndex: 0, account, amount: 150n },
    { eventName: 'PoolReset', block: 4n, logIndex: 1, account, generation: 1n },
  ])
  expect(ledger.poolOf(account)).toEqual({ assets: 0n, shares: 0n, queued: 0n, generation: 1n })
  expect(ledger.positionOf(account, delegator)).toMatchObject({ shares: 0n, queued: 0n, generation: 1n })
  const retired = ledger.snapshot()
  expect([...retired.positions.values()].every((position) => position.active === 0n)).toBe(true)
  ledger.apply(deposit(5n, 40n))
  expect(ledger.positionOf(account, delegator)).toMatchObject({ shares: 40n, queued: 0n, generation: 1n })
  expect(ledger.activeShares(account, other)).toBe(0n)
  expect(ledger.stakeOf(account)).toBe(40n)
  expect(retired.pools.get(account)?.assets).toBe(0n)
})

test('a full forfeiture also resets, but full withdrawal retains the generation', () => {
  const forfeited = replayLedger([
    deposit(1n, 100n),
    { eventName: 'Forfeited', block: 2n, logIndex: 0, account, amount: 100n },
    { eventName: 'PoolReset', block: 2n, logIndex: 1, account, generation: 1n },
  ])
  expect(forfeited.poolOf(account).generation).toBe(1n)
  const withdrawn = replayLedger([
    deposit(1n, 100n),
    queue(2n, 100n, 100n),
    { eventName: 'Withdrawn', block: 3n, logIndex: 0, account, delegator, shares: 100n, assets: 100n },
    deposit(4n, 50n),
  ])
  expect(withdrawn.poolOf(account)).toEqual({ assets: 50n, shares: 50n, queued: 0n, generation: 0n })
})

test('pool share-price replay handles post-slash deposits and withdrawal rounding', () => {
  const ledger = replayLedger([
    deposit(1n, 100n),
    { eventName: 'Slashed', block: 2n, logIndex: 0, account, amount: 40n },
    deposit(3n, 30n, 50n, other),
    queue(4n, 7n, 7n, 4n),
    { eventName: 'Withdrawn', block: 5n, logIndex: 0, account, delegator, shares: 7n, assets: 4n },
  ])
  expect(ledger.poolOf(account)).toEqual({ assets: 86n, shares: 143n, queued: 0n, generation: 0n })
  expect(ledger.stakeOf(account)).toBe(86n)
})

test('activation ranks match the schedule and current replayed stake, including reservations', () => {
  const ledger = replayLedger([schedule, deposit(2n, 10000n * side), activation])
  expect(ledger.activationOf(holding, 1n)).toMatchObject({ rank: 1, feeBps: 1000n, fee: 10n, net: 90n })
  expect(ledger.wallets.get(account)).toEqual(new Set([1n]))
  expect(() => replayLedger([schedule, deposit(2n, 9999n * side), activation])).toThrow(
    'vault replay disagrees with activation snapshot',
  )
  expect(() => replayLedger([schedule, deposit(2n, 10000n * side), { ...activation, feeBps: 999n }])).toThrow('unknown')
})

test('a schedule change before activation uses the new thresholds and exact log order', () => {
  const changed = {
    ...schedule,
    block: 3n,
    logIndex: 0,
    thresholds: [0n, 20000n * side, 200000n * side, 2000000n * side],
  }
  const ledger = replayLedger(
    [schedule, deposit(2n, 10000n * side), changed, { ...activation, feeBps: 3000n }].toReversed(),
  )
  expect(ledger.activationOf(holding, 1n).rank).toBe(0)
})

test('top-ups, share settings, all wallet IDs and funding retain chain positions', () => {
  const records: LedgerRecord[] = [
    schedule,
    deposit(2n, 10000n * side),
    activation,
    { ...activation, block: 4n, jobId: 2n, agentId: 2n },
    { eventName: 'ToppedUp', block: 5n, logIndex: 0, holding, jobId: 1n, contributor: other, amount: 10n, bonus: 10n },
    { eventName: 'ToppedUp', block: 6n, logIndex: 0, holding, jobId: 1n, contributor: other, amount: 20n, bonus: 30n },
    { eventName: 'MetadataSet', block: 7n, logIndex: 0, agentId: 1n, key: 'sidequest.backerShareBps', value: '0x' },
    { eventName: 'MetadataSet', block: 7n, logIndex: 1, agentId: 1n, key: 'other', value: '0x' },
    { eventName: 'EpochFunded', block: 8n, logIndex: 0, epoch: 0n, amount: 100n, totalFunded: 100n },
  ]
  const ledger = replayLedger(records.toReversed())
  expect(ledger.wallets.get(account)).toEqual(new Set([1n, 2n]))
  expect(ledger.shareSets.get(1n)).toHaveLength(1)
  expect(ledger.funding).toMatchObject([{ epoch: 0n, amount: 100n, block: 8n }])
  const fee: FeeCharged = {
    block: 6n,
    logIndex: 0,
    tx,
    holding,
    jobId: 1n,
    token: holding,
    worker: account,
    creator: other,
    amount: 10n,
    bonusPart: 0n,
  }
  expect(ledger.bonusBefore(fee)).toBe(10n)
  expect(ledger.bonusBefore({ ...fee, logIndex: 1 })).toBe(30n)
  const snapshot = ledger.snapshot()
  ledger.apply({ ...activation, block: 9n, agentId: 3n, jobId: 3n })
  expect(snapshot.wallets.get(account)).toEqual(new Set([1n, 2n]))
})

test('incomplete histories, skipped generations and duplicate/out-of-order application refuse', () => {
  expect(() => replayLedger([queue(1n, 1n, 1n)])).toThrow('history')
  expect(() => replayLedger([deposit(1n, 100n), queue(2n, 20n, 50n)])).toThrow('queue history')
  expect(() => replayLedger([{ eventName: 'PoolReset', block: 1n, logIndex: 0, account, generation: 2n }])).toThrow(
    'reset history',
  )
  const ledger = new MiningLedger()
  ledger.apply(deposit(2n, 10n))
  expect(() => ledger.apply(deposit(1n, 10n))).toThrow('chain order')
  expect(() => ledger.apply(deposit(2n, 10n))).toThrow('duplicated')
  expect(() => ledger.activationOf(holding, 100n)).toThrow('missing')
  expect(ledger.stakeOf(other)).toBe(0n)
})
