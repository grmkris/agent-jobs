import { expect, test } from 'bun:test'
import { deployment } from '../../packages/sdk/src/deployment.ts'
import { MiningLedger } from './ledger.ts'
import { checkIntegrity, type IntegrityInput } from './integrity.ts'
import type { FeeCharged } from './compute.ts'
import { lower } from './ledger-chain.ts'
import type { PublicClient } from './viem.ts'

const worker = '0x0000000000000000000000000000000000000001'
const holding = '0x0000000000000000000000000000000000000002'
const treasury = '0x0000000000000000000000000000000000000003'
const tx = `0x${'ab'.repeat(32)}` as const
const value = `0x${5000n.toString(16).padStart(64, '0')}` as const

function fixture(override: Record<string, unknown> = {}) {
  const d = deployment('monad-testnet'),
    h = d.sidequest
  if (h === null) throw new Error('configured deployment missing')
  const ledger = new MiningLedger()
  ledger.apply({
    eventName: 'ScheduleExecuted',
    block: 1n,
    logIndex: 0,
    tx,
    thresholds: [0n, 10n, 100n, 1000n],
    bps: [3000n, 1000n, 300n, 100n],
    treasury,
  })
  ledger.apply({
    eventName: 'Delegated',
    block: 2n,
    logIndex: 0,
    account: worker,
    delegator: worker,
    assets: 10n,
    shares: 10n,
  })
  ledger.apply({
    eventName: 'MetadataSet',
    block: 3n,
    logIndex: 0,
    agentId: 1n,
    tx,
    key: 'sidequest.backerShareBps',
    value,
  })
  ledger.apply({
    eventName: 'Activated',
    block: 4n,
    logIndex: 0,
    tx,
    holding,
    worker,
    jobId: 1n,
    agentId: 1n,
    feeBps: 1000n,
    fee: 10n,
    net: 90n,
  })
  ledger.apply({ eventName: 'EpochFunded', block: 6n, logIndex: 0, epoch: 1n, amount: 100n })
  const fee: FeeCharged = {
    block: 5n,
    logIndex: 0,
    tx,
    holding,
    worker,
    creator: treasury,
    jobId: 1n,
    token: h.factory,
    amount: 10n,
    bonusPart: 0n,
  }
  const pool = { assets: 10n, reserved: 0n, shares: 10n, queuedShares: 0n, generation: 0n }
  const listing = { reward: 100n, fee: 10n, feeBps: 1000, bonus: 0n, worker }
  const schedule = { thresholds: [0n, 10n, 100n, 1000n], bps: [3000, 1000, 300, 100], treasury }
  const values: Record<string, unknown> = {
    totalAssets: 10n,
    poolOf: pool,
    schedule,
    getMetadata: value,
    getListing: listing,
    feeSchedule: lower(h.feeSchedule),
    vault: lower(h.vault),
    identity: lower(d.identity),
    totalFunded: 100n,
    ...override,
  }
  const reads: { functionName: string; blockNumber?: bigint }[] = []
  // SAFETY: This unit double implements the only client method checkIntegrity calls, with ABI-shaped responses.
  const c = {
    readContract: async (request: { functionName: string; blockNumber?: bigint }) => {
      reads.push(request)
      return values[request.functionName]
    },
  } as PublicClient
  return {
    input: {
      c,
      deployment: d,
      sidequest: h,
      holdings: [holding],
      head: 9n,
      ledger,
      fees: [fee],
      workers: [worker],
      agentIds: [1n],
    },
    reads,
    pool,
    listing,
    schedule,
    values,
  }
}

const expectRefusal = (input: IntegrityInput, message: string) =>
  checkIntegrity(input).then(
    () => {
      throw new Error('expected integrity refusal')
    },
    (error: unknown) => {
      if (!(error instanceof Error)) throw new Error('unexpected integrity rejection')
      expect(error.message).toContain(message)
    },
  )

test('integrity verifies replay against one finalized block; only the funding finality reread is latest', async () => {
  const f = fixture()
  await checkIntegrity(f.input)
  expect(f.reads.filter((read) => read.blockNumber === undefined)).toEqual([
    { functionName: 'totalFunded', address: f.input.sidequest.miningReserve, abi: expect.any(Array) },
  ])
  expect(f.reads.filter((read) => read.blockNumber !== undefined).every((read) => read.blockNumber === 9n)).toBe(true)
  expect(new Set(f.reads.map((read) => read.functionName))).toEqual(
    new Set([
      'totalAssets',
      'poolOf',
      'schedule',
      'getMetadata',
      'getListing',
      'feeSchedule',
      'vault',
      'identity',
      'totalFunded',
    ]),
  )
})

test('vault totalAssets and every replayed pool accounting field refuse disagreement', async () => {
  await expectRefusal(fixture({ totalAssets: 11n }).input, 'totalAssets')
  const base = fixture().pool
  for (const patch of [{ assets: 11n }, { shares: 11n }, { queuedShares: 1n }, { generation: 1n }])
    await expectRefusal(fixture({ poolOf: { ...base, ...patch } }).input, 'poolOf')
})

test('schedule thresholds, fee rates and treasury must all agree', async () => {
  const base = fixture().schedule
  for (const patch of [{ thresholds: [0n, 11n, 100n, 1000n] }, { bps: [3000, 900, 300, 100] }, { treasury: worker }])
    await expectRefusal(fixture({ schedule: { ...base, ...patch } }).input, 'fee schedule')
})

test('metadata is checked as raw bytes, including missing and malformed values', async () => {
  for (const getMetadata of ['0x', '0x01', `0x${'00'.repeat(32)}`])
    await expectRefusal(fixture({ getMetadata }).input, 'getMetadata')
})

test('every counted listing must match reward, base fee, snapshotted rate, bonus and worker', async () => {
  const base = fixture().listing
  for (const patch of [{ reward: 101n }, { fee: 11n }, { feeBps: 900 }, { bonus: 1n }, { worker: treasury }])
    await expectRefusal(fixture({ getListing: { ...base, ...patch } }).input, 'getListing')
})

test('holding links, full funding sum and funding finality refuse mismatch', async () => {
  for (const key of ['feeSchedule', 'vault', 'identity'])
    await expectRefusal(fixture({ [key]: worker }).input, 'holding config')
  await expectRefusal(fixture({ totalFunded: 101n }).input, 'totalFunded')
  const f = fixture()
  let reads = 0
  // SAFETY: The unit client keeps ABI-shaped responses and changes only the second funding read.
  f.input.c = {
    readContract: async (request: { functionName: string }) =>
      request.functionName === 'totalFunded' && ++reads > 1 ? 101n : f.values[request.functionName],
  } as PublicClient
  await expectRefusal(f.input, 'not final')
})
