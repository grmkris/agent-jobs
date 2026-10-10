import { expect, test } from 'bun:test'
import {
  BACKER_SHARE_KEY,
  backerInputs,
  decodeBackerShareBps,
  replayVaultEvents,
  resolveBackerWorkers,
  type BackerWorker,
  type MetadataSetRecord,
  type VaultEventRecord,
  type WorkerAgentRecord,
} from './backers.ts'
import { computeEpoch, dataHashOf, leafValues, type FeeCharged } from './compute.ts'
import { buildTree } from './tree.ts'
import type { PriceList } from './prices.ts'
import { encodeAbiParameters, type Address } from './viem.ts'

const A = '0x0000000000000000000000000000000000000001'
const B = '0x0000000000000000000000000000000000000002'
const C = '0x0000000000000000000000000000000000000003'
const D = '0x0000000000000000000000000000000000000004'
const H = '0x0000000000000000000000000000000000000005'
const TX = `0x${'11'.repeat(32)}` as const
const word = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n])
const fee: FeeCharged = {
  block: 20n,
  logIndex: 9,
  tx: TX,
  holding: H,
  jobId: 1n,
  worker: A,
  creator: B,
  token: H,
  amount: 202n,
  bonusPart: 0n,
}
const activation: WorkerAgentRecord = { ...fee, block: 5n, logIndex: 0, agentId: 1n }
const metadata: MetadataSetRecord = {
  ...fee,
  block: 8n,
  logIndex: 0,
  agentId: 1n,
  key: BACKER_SHARE_KEY,
  value: word(5000n),
}
const delegate = (block: bigint, delegator: Address, shares: bigint, account: Address = A): VaultEventRecord => ({
  block,
  logIndex: 0,
  account,
  delegator,
  eventName: 'Delegated',
  shares,
})
const queue = (block: bigint, delegator: Address, queuedShares: bigint): VaultEventRecord => ({
  block,
  logIndex: 0,
  account: A,
  delegator,
  eventName: 'UndelegateRequested',
  queuedShares,
})
const cancel = (block: bigint, delegator: Address): VaultEventRecord => ({
  block,
  logIndex: 0,
  account: A,
  delegator,
  eventName: 'UndelegateCancelled',
})
const workers = (logs: readonly VaultEventRecord[] = [delegate(2n, C, 1n), delegate(3n, D, 2n)], sets = [metadata]) =>
  resolveBackerWorkers({
    fees: [fee],
    activations: [activation],
    metadata: sets,
    positions: replayVaultEvents(logs, 10n, 20n),
    fromBlock: 10n,
  })
const run = (backerWorkers?: readonly BackerWorker[], fees: readonly FeeCharged[] = [fee]) =>
  computeEpoch({
    fees,
    owed: [],
    withdrawals: [],
    budget: 101n,
    ...(backerWorkers === undefined ? {} : { backerWorkers }),
    prices: { epoch: 0n, tokens: [{ token: H, decimals: 18, usdPrice: 10n ** 18n }], factoryUsdPrice: 10n ** 18n },
  })

test('50 percent with uneven weights conserves the original leaf total; worker receives all backer rounding', () => {
  const result = run(workers())
  // Worker pool 60; backer cut 30 splits 10/20. Creator pool remains 40.
  expect(result.leaves).toEqual([
    { account: A, amount: 30n },
    { account: B, amount: 40n },
    { account: C, amount: 10n },
    { account: D, amount: 20n },
  ])
  expect(result.total).toBe(run().total)
  const uneven = run(workers([delegate(2n, C, 1n), delegate(3n, D, 3n)]))
  expect(uneven.leaves).toEqual([
    { account: A, amount: 31n },
    { account: B, amount: 40n },
    { account: C, amount: 7n },
    { account: D, amount: 22n },
  ])
  expect(uneven.total).toBe(100n)
})

test('100 percent still gives the worker the backer rounding remainder', () => {
  const result = run(workers([delegate(2n, C, 1n), delegate(3n, D, 6n)], [{ ...metadata, value: word(10000n) }]))
  expect(result.leaves).toEqual([
    { account: A, amount: 1n },
    { account: B, amount: 40n },
    { account: C, amount: 8n },
    { account: D, amount: 51n },
  ])
  expect(result.total).toBe(100n)
})

test('positive share without weighted backers leaves the full allocation with the worker', () => {
  expect(run(workers([]))).toEqual(run())
  expect(run(workers([delegate(11n, C, 1000n)]))).toEqual(run())
})

test('an epoch join has zero start; later added backing cannot increase the start weight', () => {
  expect(replayVaultEvents([delegate(10n, C, 100n)], 10n, 20n)).toEqual([
    { account: A, delegator: C, start: 0n, end: 100n, weight: 0n },
  ])
  expect(replayVaultEvents([delegate(2n, C, 100n), delegate(12n, C, 50n)], 10n, 20n)).toEqual([
    { account: A, delegator: C, start: 100n, end: 150n, weight: 100n },
  ])
})

test('leaving counts remaining active shares, and requests set the whole queue', () => {
  const logs = [delegate(2n, C, 100n), queue(12n, C, 20n), queue(13n, C, 60n)]
  expect(replayVaultEvents(logs, 10n, 20n)).toEqual([{ account: A, delegator: C, start: 100n, end: 40n, weight: 40n }])
  expect(replayVaultEvents([...logs, queue(20n, C, 100n)], 10n, 20n)[0]?.weight).toBe(0n)
})

test('a cancelled leave counts again by epoch end, but cannot restore shares queued at epoch start', () => {
  expect(replayVaultEvents([delegate(2n, C, 100n), queue(12n, C, 80n), cancel(20n, C)], 10n, 20n)[0]).toMatchObject({
    start: 100n,
    end: 100n,
    weight: 100n,
  })
  expect(replayVaultEvents([delegate(2n, C, 100n), queue(9n, C, 80n), cancel(12n, C)], 10n, 20n)[0]).toMatchObject({
    start: 20n,
    end: 100n,
    weight: 20n,
  })
})

test('withdrawal subtracts shares and clears the queue; after-end events do not affect endpoints', () => {
  const logs: VaultEventRecord[] = [
    delegate(2n, C, 100n),
    queue(12n, C, 70n),
    { block: 18n, logIndex: 0, account: A, delegator: C, eventName: 'Withdrawn', shares: 70n },
    delegate(21n, C, 200n),
  ]
  expect(replayVaultEvents(logs.toReversed(), 10n, 20n)[0]).toMatchObject({ start: 100n, end: 30n, weight: 30n })
})

test('pool reset zeroes all old positions; a new deposit into the same position has zero start', () => {
  const logs: VaultEventRecord[] = [
    delegate(2n, C, 100n),
    delegate(3n, D, 200n),
    queue(4n, C, 30n),
    { block: 12n, logIndex: 0, account: A, eventName: 'PoolReset', generation: 1n },
    delegate(13n, C, 400n),
  ]
  expect(replayVaultEvents(logs, 10n, 20n)).toEqual([
    { account: A, delegator: C, start: 0n, end: 400n, weight: 0n },
    { account: A, delegator: D, start: 0n, end: 0n, weight: 0n },
  ])
  expect(run(workers(logs))).toEqual(run())
})

test('reset before start normalizes old positions and another pool is unaffected', () => {
  const logs: VaultEventRecord[] = [
    delegate(1n, C, 20n),
    delegate(2n, D, 50n, B),
    { block: 3n, logIndex: 0, account: A, eventName: 'PoolReset', generation: 1n },
    delegate(9n, C, 10n),
  ]
  expect(replayVaultEvents(logs, 10n, 20n)).toEqual([
    { account: A, delegator: C, start: 10n, end: 10n, weight: 10n },
    { account: B, delegator: D, start: 50n, end: 50n, weight: 50n },
  ])
})

test('slash and forfeiture change assets only; block/logIndex order determines the boundary', () => {
  const logs: VaultEventRecord[] = [
    delegate(9n, C, 100n),
    { ...queue(9n, C, 20n), logIndex: 1 },
    { block: 12n, logIndex: 0, account: A, eventName: 'Slashed' },
    { block: 13n, logIndex: 0, account: A, eventName: 'Forfeited' },
  ]
  expect(replayVaultEvents(logs.toReversed(), 10n, 20n)[0]).toMatchObject({ start: 80n, end: 80n, weight: 80n })
})

test('incomplete position/reset history refuses instead of creating negative weights', () => {
  expect(() => replayVaultEvents([queue(2n, C, 100n)], 10n, 20n)).toThrow('position history')
  expect(() =>
    replayVaultEvents(
      [{ block: 2n, logIndex: 0, account: A, delegator: C, eventName: 'Withdrawn', shares: 1n }],
      10n,
      20n,
    ),
  ).toThrow('position history')
  expect(() =>
    replayVaultEvents([{ block: 2n, logIndex: 0, account: A, eventName: 'PoolReset', generation: 2n }], 10n, 20n),
  ).toThrow('reset history')
})

test('the last metadata strictly before fromBlock applies; in-window settings wait for the next epoch', () => {
  const sets = [
    { ...metadata, block: 10n, value: word(10000n) },
    { ...metadata, block: 9n, value: word(2500n) },
    metadata,
  ]
  expect(workers([], sets)[0]?.bps).toBe(2500n)
  const next = resolveBackerWorkers({
    fees: [fee],
    activations: [activation],
    metadata: sets,
    positions: [],
    fromBlock: 21n,
  })
  expect(next[0]?.bps).toBe(10000n)
  expect(workers([], [{ ...metadata, block: 10n }])[0]?.bps).toBe(0n)
})

test('metadata in the same block resolves by logIndex and malformed later sets override valid older ones', () => {
  const late = { ...metadata, logIndex: 2, value: word(10001n) }
  expect(workers([], [late, { ...metadata, logIndex: 1 }])[0]?.bps).toBe(10000n)
  expect(workers([], [metadata, { ...late, value: '0x01' }])[0]?.bps).toBe(0n)
})

test('decode a uint256 word, cap at 10000, and opt out for unset or non-32-byte metadata', () => {
  expect(decodeBackerShareBps(word(5000n))).toBe(5000n)
  expect(decodeBackerShareBps(word((1n << 256n) - 1n))).toBe(10000n)
  for (const value of ['0x', '0x1234', `0x${'11'.repeat(31)}`, `0x${'11'.repeat(33)}`] as const)
    expect(decodeBackerShareBps(value)).toBe(0n)
  expect(workers([], [])[0]?.bps).toBe(0n)
  expect(workers([], [{ ...metadata, key: 'other-key' }])[0]?.bps).toBe(0n)
})

test('activation must match Holding, job, wallet and precede the fee; missing/conflicting IDs opt out', () => {
  const patches: Partial<WorkerAgentRecord>[] = [{ holding: B }, { jobId: 2n }, { worker: C }, { block: 21n }]
  for (const patch of patches) {
    expect(
      resolveBackerWorkers({
        fees: [fee],
        activations: [{ ...activation, ...patch }],
        metadata: [metadata],
        positions: [],
        fromBlock: 10n,
      })[0]?.bps,
    ).toBe(0n)
  }
  const sameId = resolveBackerWorkers({
    fees: [fee, { ...fee, jobId: 2n }],
    activations: [activation, { ...activation, jobId: 2n }],
    metadata: [metadata],
    positions: [],
    fromBlock: 10n,
  })
  expect(sameId).toHaveLength(1)
  expect(sameId[0]?.bps).toBe(5000n)
  const conflict = resolveBackerWorkers({
    fees: [fee, { ...fee, jobId: 2n }],
    activations: [activation, { ...activation, jobId: 2n, agentId: 2n }],
    metadata: [metadata],
    positions: [],
    fromBlock: 10n,
  })
  expect(conflict[0]).toMatchObject({ agentId: 0n, bps: 0n, set: null })
})

test('self-backing gets its pro-rata part; worker/creator/backer roles merge in one leaf', () => {
  const inputs = workers([delegate(2n, A, 1n), delegate(3n, C, 2n)])
  expect(run(inputs).leaves).toEqual([
    { account: A, amount: 40n },
    { account: B, amount: 40n },
    { account: C, amount: 20n },
  ])
  const result = run(inputs, [{ ...fee, creator: A }])
  expect(result.leaves).toEqual([
    { account: A, amount: 80n },
    { account: C, amount: 20n },
  ])
  expect(result.total).toBe(100n)
})

test('all zero shares preserve exact old leaves, root and dataHash and omit both input keys', () => {
  const optOut = workers(undefined, [{ ...metadata, value: word(0n) }])
  const original = run()
  const result = run(optOut)
  expect(result).toEqual(original)
  expect(buildTree(leafValues(0n, result.leaves)).tree[0]).toBe(buildTree(leafValues(0n, original.leaves)).tree[0])
  expect(buildTree(leafValues(0n, result.leaves)).tree[0]).toBe(
    '0xdeef79190e8db8c9bdf439f5c52920a3c3edd778f939daf75d0c078afc305fb0',
  )
  const oldInputs = { chainId: 10143, epoch: '0', fees: [{ jobId: '1', amount: '5' }] }
  const additions = backerInputs(optOut)
  const inputs = additions === undefined ? oldInputs : { ...oldInputs, ...additions }
  expect(JSON.stringify(inputs)).toBe(JSON.stringify(oldInputs))
  expect(dataHashOf(inputs)).toBe(dataHashOf(oldInputs))
  expect(dataHashOf(inputs)).toBe('0xdc17381e8459339541d3d1f7f7be0d6c67307c5feaca74a463b9931c96943333')
  expect(inputs).not.toHaveProperty('backerShares')
  expect(inputs).not.toHaveProperty('backerPositions')
})

test('positive-share inputs retain metadata provenance and deterministic position ordering', () => {
  const resolved = workers([delegate(3n, D, 2n), delegate(2n, C, 1n)])
  expect(backerInputs(resolved)).toEqual({
    backerShares: [{ agentId: '1', worker: A, bps: '5000', set: { block: '8', logIndex: 0, tx: TX } }],
    backerPositions: [
      { account: A, delegator: C, start: '1', end: '1', weight: '1' },
      { account: A, delegator: D, start: '2', end: '2', weight: '2' },
    ],
  })
})

test('cross-pool worker, creator and backer payments merge independently of allocation order', () => {
  const fees: FeeCharged[] = [fee, { ...fee, worker: C, creator: A, jobId: 2n }]
  const first: BackerWorker = {
    worker: A,
    agentId: 1n,
    bps: 5000n,
    set: metadata,
    positions: [{ account: A, delegator: C, start: 1n, end: 1n, weight: 1n }],
  }
  const second: BackerWorker = {
    worker: C,
    agentId: 2n,
    bps: 10000n,
    set: metadata,
    positions: [{ account: C, delegator: A, start: 1n, end: 1n, weight: 1n }],
  }
  const result = run([first, second], fees)
  expect(result.leaves).toEqual([
    { account: A, amount: 65n },
    { account: B, amount: 20n },
    { account: C, amount: 15n },
  ])
  expect(result.total).toBe(run(undefined, fees).total)
  expect(run([second, first], fees)).toEqual(result)
  expect(backerInputs([second, first])).toEqual(backerInputs([first, second]))
})

test('small allocations across the full share range conserve the old total with no negative or duplicate leaves', () => {
  const positions = workers()[0]?.positions
  if (positions === undefined) throw new Error('fixture positions missing')
  const prices: PriceList = {
    epoch: 0n,
    tokens: [{ token: H, decimals: 18, usdPrice: 10n ** 18n }],
    factoryUsdPrice: 10n ** 18n,
  }
  for (const budget of [0n, 1n, 2n, 3n, 7n, 11n, 17n, 31n, 101n]) {
    const input = { fees: [fee], owed: [], withdrawals: [], prices, budget }
    const original = computeEpoch(input)
    for (const bps of [0n, 1n, 4999n, 5000n, 9999n, 10000n]) {
      const result = computeEpoch({ ...input, backerWorkers: [{ worker: A, agentId: 1n, bps, positions }] })
      expect(result.total).toBe(original.total)
      expect(result.leaves.every((leaf) => leaf.amount > 0n)).toBe(true)
      expect(new Set(result.leaves.map((leaf) => leaf.account)).size).toBe(result.leaves.length)
    }
  }
})
