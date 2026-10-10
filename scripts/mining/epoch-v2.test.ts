import { deployment } from '../../packages/sdk/src/deployment.ts'
import { epochDistributorAbi } from '../../packages/sdk/src/abi/epochDistributor.ts'
import { readEpochFile } from '../../apps/explore/src/admin.ts'
import { miningProof } from '../../packages/board/src/mining.ts'
import { expect, test } from 'bun:test'
import { computeLedgerEpoch, replayEpochLedger } from './epoch-v2.ts'
import { canonicalRuleV2, inputsV2Of, checkCanonicalPriceTokens } from './inputs-v2.ts'
import { checkPriceRule, type PriceList } from './prices.ts'
import { rebuildRecorded, firstEpochDiff } from './recompute.ts'
import { dataHashOf, leafValues } from './compute.ts'
import { buildTree, proofOf } from './tree.ts'
import { parseEpoch, stageOf } from './publish-lib.ts'
import type { EpochChainRecord } from './ledger-chain.ts'
import type { ActivationEvent, ScheduleExecutedRecord } from './ledger.ts'
import { chainOrder } from './credit.ts'
import { encodeFunctionData, type Address, type PublicClient } from './viem.ts'

const worker = '0x0000000000000000000000000000000000000001'
const borrower = '0x0000000000000000000000000000000000000002'
const creator = '0x0000000000000000000000000000000000000003'
const backer = '0x0000000000000000000000000000000000000004'
const dust = '0x0000000000000000000000000000000000000005'
const holding = '0x0000000000000000000000000000000000000006'
const token = '0x0000000000000000000000000000000000000007'
const factory = '0x0000000000000000000000000000000000000008'
const tx = `0x${'ab'.repeat(32)}` as const
const side = 10n ** 18n
const prices: PriceList = { epoch: 30n, tokens: [{ token, decimals: 6, usdPrice: side }], factoryUsdPrice: 10n ** 15n }
const schedule: ScheduleExecutedRecord = {
  eventName: 'ScheduleExecuted',
  block: 1n,
  logIndex: 0,
  tx,
  thresholds: [0n, 10000n * side, 100000n * side, 1000000n * side],
  bps: [3000n, 1000n, 300n, 100n],
  treasury: creator,
}
const deposit = (block: bigint, account: Address, delegator: Address, amount: bigint): EpochChainRecord => ({
  eventName: 'Delegated',
  block,
  logIndex: 0,
  account,
  delegator,
  assets: amount,
  shares: amount,
})
const metadata = (block: bigint, agentId: bigint, bps: bigint): EpochChainRecord => ({
  eventName: 'MetadataSet',
  block,
  logIndex: 0,
  tx,
  agentId,
  key: 'sidequest.backerShareBps',
  value: `0x${bps.toString(16).padStart(64, '0')}`,
})
const activation = (
  block: bigint,
  account: Address,
  agentId: bigint,
  jobId: bigint,
  feeBps = 1000n,
): ActivationEvent => ({
  eventName: 'Activated',
  block,
  logIndex: 0,
  tx,
  holding,
  jobId,
  worker: account,
  agentId,
  feeBps,
  fee: (100000000n * feeBps) / 10000n,
  net: 100000000n - (100000000n * feeBps) / 10000n,
})
const fee = (block: bigint, activated: ActivationEvent): EpochChainRecord => ({
  eventName: 'FeeCharged',
  block,
  logIndex: 0,
  tx,
  holding,
  jobId: activated.jobId,
  token,
  worker: activated.worker,
  creator,
  amount: activated.fee,
  bonusPart: 0n,
})

function history(): EpochChainRecord[] {
  const old = activation(8n, worker, 1n, 90n)
  const a = activation(11n, worker, 2n, 1n)
  const b = activation(13n, borrower, 3n, 2n, 300n)
  return [
    schedule,
    deposit(2n, worker, worker, 1000n * side),
    deposit(3n, worker, backer, 9000n * side),
    deposit(4n, worker, dust, 1n),
    metadata(5n, 1n, 5000n),
    metadata(7n, 1n, 1000n),
    old,
    a,
    deposit(12n, borrower, borrower, 100000n * side),
    b,
    {
      eventName: 'UndelegateRequested',
      block: 14n,
      logIndex: 0,
      account: borrower,
      delegator: borrower,
      shares: 100000n * side,
      assets: 100000n * side,
      queuedShares: 100000n * side,
    },
    fee(15n, a),
    fee(16n, b),
  ]
}
const run = (records = history(), shareBlock = 4n) => {
  const replay = replayEpochLedger(records, 10n, 20n)
  return { replay, ...computeLedgerEpoch(replay, prices, 10n ** 30n, shareBlock, 10n) }
}

function artifactOf(records = history()) {
  const r = run(records)
  const inputs = inputsV2Of({
    chainId: 10143,
    epoch: 30n,
    rule: canonicalRuleV2(30n, 6n, false, []),
    window: { start: '10', end: '21', fromBlock: '10', toBlock: '20', toBlockHash: tx },
    shareWindow: { start: '4', block: '4' },
    holdings: [holding],
    priceList: {
      message: {
        epoch: '30',
        tokens: [{ token, decimals: 6, usdPrice: side.toString() }],
        factoryUsdPrice: prices.factoryUsdPrice.toString(),
      },
      signer: creator,
      signature: `0x${'aa'.repeat(65)}`,
    },
    factoryPriceEvidence: { previousSignedPrice: null },
    budget: { available: (10n ** 30n).toString() },
    feeSchedules: r.replay.end.feeSchedules,
    fees: r.result.fees,
    topUps: r.topUps,
    backing: r.stakes,
    backerShares: r.shares,
    backerPositions: r.result.backerPositions,
  })
  const tree = buildTree(leafValues(30n, r.result.leaves))
  const claims: Record<string, { amount: string; proof: `0x${string}`[] }> = {}
  tree.values.forEach((value, i) => {
    claims[value.value[1]] = { amount: value.value[2], proof: proofOf(tree, i) }
  })
  return {
    rule: 2,
    chainId: 10143,
    epoch: '30',
    inputs,
    dataHash: dataHashOf(inputs),
    tree,
    claims,
    root: tree.tree[0],
    total: r.result.total.toString(),
  }
}

test('synthetic ledger integrates two tiers, borrowed backing, backer shares and a one-wei dust position', () => {
  const r = run()
  expect(r.result.fees.map((row) => row.credit?.activationRank)).toEqual([1, 2])
  expect(r.result.fees.map((row) => row.credit?.heldRank)).toEqual([1, 0])
  expect(r.result.feeUsd).toBe(13n * side)
  expect(r.result.creditUsd).toBe(side)
  expect(r.result.emission).toBe(500n * side)
  expect(r.result.backerPositions.some((p) => p.delegator === dust)).toBe(false)
  expect(r.result.leaves.find((leaf) => leaf.account === backer)?.amount).toBe(81n * side)
  expect(r.result.total).toBe(500n * side)
})

test('a cut inside the notice window keeps the earlier value, while an older cut applies', () => {
  expect(run().shares.find((share) => share.worker === worker)?.bps).toBe(5000n)
  expect(run(history(), 8n).shares.find((share) => share.worker === worker)?.bps).toBe(1000n)
})

test('a raise before the epoch applies and an in-epoch raise waits', () => {
  const records = [...history(), metadata(9n, 1n, 7000n), metadata(17n, 1n, 9000n)]
  expect(run(records).shares.find((share) => share.worker === worker)?.bps).toBe(7000n)
})

test('working under a second ID keeps the wallet maximum and records the first identity as its source', () => {
  const share = run().shares.find((entry) => entry.worker === worker)
  expect(share?.agentIds).toEqual([1n, 2n])
  expect(share?.bps).toBe(5000n)
  expect(share?.source).toMatchObject({ agentId: 1n, block: 5n })
})

test('uncounted in-epoch activations do not introduce a new wallet share identity', () => {
  const r = run([...history(), metadata(6n, 4n, 10000n), activation(19n, worker, 4n, 4n)])
  expect(r.shares.find((share) => share.worker === worker)?.agentIds).toEqual([1n, 2n])
})

test('an inflated SIDE fee-token price refuses before a v2 artifact can be accepted', () => {
  expect(() =>
    checkPriceRule(
      { ...prices, tokens: [{ token: factory, decimals: 18, usdPrice: side }] },
      { factory, factoryUsdPrice: prices.factoryUsdPrice, network: 'monad-testnet', usdPegged: [] },
    ),
  ).toThrow('reference price')
})

test('activation worker mismatch refuses the integrated computation', () => {
  const records = history().map((record) =>
    record.eventName === 'FeeCharged' && record.jobId === 1n ? { ...record, worker: borrower } : record,
  )
  expect(() => run(records)).toThrow('worker or holding')
})

test('a bonus fee rounded down refuses, including complete top-up history', () => {
  const records = history().map((record) =>
    record.eventName === 'FeeCharged' && record.jobId === 1n
      ? { ...record, amount: record.amount + 1n, bonusPart: 1n }
      : record,
  )
  records.push({
    eventName: 'ToppedUp',
    block: 12n,
    logIndex: 1,
    tx,
    holding,
    jobId: 1n,
    contributor: backer,
    amount: 11n,
    bonus: 11n,
  })
  expect(() => run(records)).toThrow('rounding')
})

test('activation rank disagreement and degenerate schedules refuse during replay', () => {
  expect(() => run(history().filter((record) => record.eventName !== 'Delegated' || record.block !== 12n))).toThrow(
    'snapshot',
  )
  expect(() =>
    run(
      history().map((record) =>
        record.eventName === 'ScheduleExecuted' ? { ...record, bps: [3000n, 1000n, 300n, 0n] } : record,
      ),
    ),
  ).toThrow('lowest bps')
})

test('canonical inputs and tree remain identical for reversed fetch order and rebuild from recorded v2 inputs', () => {
  const artifact = artifactOf()
  expect(artifactOf(history().toReversed())).toEqual(artifact)
  expect(firstEpochDiff(artifact, rebuildRecorded(artifact))).toBeNull()
  expect(artifact.inputs.fees[0]?.usd).toBe((10n * side).toString())
  expect(artifact.inputs.fees[0]?.credit?.usd).toBe((6n * 10n ** 17n).toString())
  expect(Object.keys(artifact.inputs)).toEqual([
    'chainId',
    'epoch',
    'rule',
    'window',
    'shareWindow',
    'holdings',
    'priceList',
    'factoryPriceEvidence',
    'budget',
    'feeSchedules',
    'fees',
    'topUps',
    'backing',
    'backerShares',
    'backerPositions',
  ])
  expect(artifact.inputs).not.toHaveProperty('checkpoint')
  expect(artifact.inputs.fees[0]?.credit?.schedule).toBe('1:0')
})

test('publication parser accepts the v2 rule and additional canonical fields', () => {
  const artifact = artifactOf()
  expect(parseEpoch(new TextEncoder().encode(JSON.stringify(artifact)), stageOf('dev')).root).toBe(artifact.root)
})

test('activation schedule stays fixed when a later schedule changes the floor', () => {
  const newSchedule = { ...schedule, block: 18n, bps: [3000n, 900n, 250n, 50n] }
  const artifact = artifactOf([...history(), newSchedule].toSorted(chainOrder))
  expect(artifact.inputs.fees.every((row) => row.credit?.floorBps === '100')).toBe(true)
})

test('Explore admin and Board proof readers accept a complete v2 artifact with the extra fields', async () => {
  const artifact = artifactOf(),
    d = deployment('monad-testnet'),
    h = d.sidequest,
    stack = d.stacks.main
  if (h === null || stack === undefined || artifact.root === undefined)
    throw new Error('test deployment or root missing')
  const file = {
    ...artifact,
    emission: (500n * side).toString(),
    calls: {
      setRoot: {
        to: h.distributor,
        data: encodeFunctionData({
          abi: epochDistributorAbi,
          functionName: 'setRoot',
          args: [30n, artifact.root, BigInt(artifact.total), artifact.dataHash],
        }),
      },
    },
  }
  expect(
    readEpochFile(JSON.stringify(file), { chainId: 10143, reserve: h.miningReserve, distributor: h.distributor }).ok,
  ).toBe(true)
  // SAFETY: The unit double implements Board's only client reads with ABI-shaped rootOf/isClaimed responses.
  const c = {
    readContract: async (request: { functionName: string }) =>
      request.functionName === 'rootOf'
        ? { root: file.root, total: BigInt(file.total), dataHash: file.dataHash }
        : false,
  } as PublicClient
  const proof = await miningProof({ publicClient: c, deployment: d, stack }, backer, '30', { load: async () => file })
  expect(proof.amount).toBe((81n * side).toString())
  expect(proof.eligible).toBe(true)
  expect(proof.transactions).toHaveLength(1)
})

test('canonical signed token arrays must be ordered without changing their signed contents', () => {
  expect(() => checkCanonicalPriceTokens([{ token }, { token: factory }])).not.toThrow()
  expect(() => checkCanonicalPriceTokens([{ token: factory }, { token }])).toThrow('address order')
  expect(() => checkCanonicalPriceTokens([{ token }, { token }])).toThrow('address order')
})
