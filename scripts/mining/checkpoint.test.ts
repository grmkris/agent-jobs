import { rejects } from 'node:assert/strict'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkpointFlags,
  findAnchor,
  loadCheckpoint,
  prepareCheckpointReplay,
  verifyCheckpoint,
  type CheckpointReader,
} from './checkpoint.ts'
import { canonicalRuleV2 } from './inputs-v2.ts'
import { inputsV2Of } from './inputs-v2.ts'
import { dataHashOf, leafValues } from './compute.ts'
import { MiningLedger } from './ledger.ts'
import { stateContractsOf, stateHashOf, stateOf, type StateContext } from './state.ts'
import { computeLedgerEpoch, replayEpochLedger } from './epoch-v2.ts'
import {
  readLedgerChain,
  ledgerHoldingEvents,
  scheduleExecutedEvent,
  fundedEvent,
  type EpochChainRecord,
} from './ledger-chain.ts'
import { metadataSetEvent, stakeVaultEvents } from './backers-chain.ts'
import { buildTree, proofOf } from './tree.ts'
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, type Address, type Hex } from './viem.ts'
import { rebuildRecorded, firstEpochDiff } from './recompute.ts'

const account = '0x0000000000000000000000000000000000000001'
const tx = `0x${'ab'.repeat(32)}` as const
const zero = `0x${'0'.repeat(64)}` as const
const rule = canonicalRuleV2(0n, 3n, false, [])
const context: StateContext = {
  chainId: 10143,
  epoch: 0n,
  block: 10n,
  blockHash: tx,
  genesisBlock: 1n,
  pruneBlock: 7n,
  contracts: {
    holdings: [account],
    vault: account,
    identity: account,
    feeSchedule: account,
    reserve: account,
    distributor: account,
  },
}
function fixture() {
  const state = stateOf(new MiningLedger(), context)
  const inputs = {
    chainId: 10143,
    epoch: '0',
    rule,
    window: { toBlock: '10', toBlockHash: tx },
    holdings: [account],
    checkpoint: { previous: null, stateHash: stateHashOf(state) },
  }
  const artifact = { rule: 2, chainId: 10143, epoch: '0', inputs, dataHash: dataHashOf(inputs) }
  const files = { artifact, state },
    anchor = { epoch: 0n, dataHash: artifact.dataHash }
  const reader: CheckpointReader = { readRoot: async () => ({ dataHash: anchor.dataHash }), blockHash: async () => tx }
  return {
    files,
    anchor,
    reader,
    chainId: 10143,
    rule,
    contracts: stateContractsOf(context.contracts),
    genesisBlock: 1n,
  }
}
const directory = () => mkdtempSync(join(tmpdir(), 'mining-checkpoint-'))

test('anchor selection scans downwards, skips empty epochs and never crosses the v2 cutover', async () => {
  const reads: bigint[] = [],
    f = fixture()
  f.reader.readRoot = async (epoch) => {
    reads.push(epoch)
    return { dataHash: epoch === 2n ? tx : zero }
  }
  expect(await findAnchor(f.reader, 5n, 1n)).toEqual({ epoch: 2n, dataHash: tx })
  expect(reads).toEqual([4n, 3n, 2n])
  reads.length = 0
  expect(await findAnchor(f.reader, 2n, 1n)).toBeNull()
  expect(reads).toEqual([1n])
  expect(await findAnchor(f.reader, 1n, 1n)).toBeNull()
})

test('a valid anchor verifies chain, rule, contracts, input hash, state hash and live block hash', async () => {
  const f = fixture()
  expect(await verifyCheckpoint(f)).toEqual({
    epoch: '0',
    dataHash: f.anchor.dataHash,
    stateHash: stateHashOf(f.files.state),
  })
})

test('a tampered state refuses independently of the anchor input hash', async () => {
  const f = fixture()
  f.files.state = { ...f.files.state, shares: { ...f.files.state.shares, pruneBlock: '8' } }
  await rejects(verifyCheckpoint(f), /stateHash mismatch/)
})

test('a mismatched anchor dataHash refuses before block reads', async () => {
  const f = fixture()
  f.anchor.dataHash = tx
  f.reader.blockHash = async () => {
    throw new Error('should not read a block')
  }
  await rejects(verifyCheckpoint(f), /dataHash mismatch/)
})

test('a reorged or missing anchor block refuses', async () => {
  for (const blockHash of [zero, null]) {
    const f = fixture()
    f.reader.blockHash = async () => blockHash
    await rejects(verifyCheckpoint(f), /block hash mismatch/)
  }
})

test('rule and contract changes refuse even when commitments are otherwise valid', async () => {
  await rejects(verifyCheckpoint({ ...fixture(), rule: canonicalRuleV2(1n, 3n, false, []) }), /rule mismatch/)
  const f = fixture()
  await rejects(verifyCheckpoint({ ...f, contracts: { ...f.contracts, holdings: [] } }), /contracts mismatch/)
  await rejects(verifyCheckpoint({ ...f, chainId: 143 }), /chain mismatch/)
})

test('missing artifact and state files refuse and optional published-store fallback loads both', async () => {
  const f = fixture(),
    dir = directory()
  try {
    await rejects(loadCheckpoint(f.anchor, dir), /missing checkpoint file epoch-0\.json/)
    writeFileSync(join(dir, 'epoch-0.json'), JSON.stringify(f.files.artifact))
    await rejects(loadCheckpoint(f.anchor, dir), /missing checkpoint file state-0\.json/)
    const keys: string[] = []
    const store = {
      get: async (_bucket: string, key: string) => {
        keys.push(key)
        return Buffer.from(JSON.stringify(f.files.state))
      },
    }
    expect(await loadCheckpoint(f.anchor, dir, { store, bucket: 'unit' })).toEqual(f.files)
    expect(keys).toEqual(['mining/state-0.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('from-genesis computes the same previous state hash without opening checkpoint files', async () => {
  const f = fixture(),
    reads: [bigint, bigint][] = []
  const result = await prepareCheckpointReplay({
    ...f,
    epoch: 2n,
    fromEpoch: 0n,
    fromBlock: 21n,
    toBlock: 30n,
    fromGenesis: true,
    checkpointDir: '/does-not-exist',
    reader: { ...f.reader, readRoot: async (epoch) => ({ dataHash: epoch === 0n ? f.anchor.dataHash : zero }) },
    stateContext: async () => context,
    readRecords: async (from, to) => {
      reads.push([from, to])
      return []
    },
  })
  expect(result.previous).toEqual({ epoch: '0', dataHash: f.anchor.dataHash, stateHash: stateHashOf(f.files.state) })
  expect(reads).toEqual([[1n, 30n]])
})

test('incremental replay starts strictly after the anchor, including empty epochs', async () => {
  const f = fixture(),
    reads: [bigint, bigint][] = [],
    dir = directory()
  try {
    writeFileSync(join(dir, 'epoch-0.json'), JSON.stringify(f.files.artifact))
    writeFileSync(join(dir, 'state-0.json'), JSON.stringify(f.files.state))
    const result = await prepareCheckpointReplay({
      ...f,
      epoch: 2n,
      fromEpoch: 0n,
      fromBlock: 21n,
      toBlock: 30n,
      checkpointDir: dir,
      reader: { ...f.reader, readRoot: async (epoch) => ({ dataHash: epoch === 0n ? f.anchor.dataHash : zero }) },
      stateContext: async () => context,
      readRecords: async (from, to) => {
        reads.push([from, to])
        return []
      },
    })
    expect(result.previous?.epoch).toBe('0')
    expect(reads).toEqual([[11n, 30n]])
    expect(result.ledger.lastPosition?.block).toBe(10n)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkpoint CLI flags have an output-directory default and reject a missing value', () => {
  expect(checkpointFlags([], '/out')).toEqual({ checkpointDir: '/out', fromGenesis: false })
  expect(checkpointFlags(['--checkpoint-dir', '/anchor', '--from-genesis'], '/out')).toEqual({
    checkpointDir: '/anchor',
    fromGenesis: true,
  })
  expect(() => checkpointFlags(['--checkpoint-dir'], '/out')).toThrow('requires a directory')
})

// The sequence uses the production ABI reader with an in-memory JSON-RPC transport.
// It includes an empty epoch, schedule change, reset, delayed share cut and a pending job crossing two epochs.
const worker = '0x0000000000000000000000000000000000000002'
const backer = '0x0000000000000000000000000000000000000003'
const token = '0x0000000000000000000000000000000000000004'
const side = 10n ** 18n
const sequenceContracts = {
  holdings: [account],
  vault: worker,
  identity: backer,
  feeSchedule: token,
  reserve: token,
  distributor: worker,
}
const sequenceRule = canonicalRuleV2(0n, 15n, false, [])
function sequenceContext(epoch: bigint): StateContext {
  const next = 20n + epoch * 10n
  return { ...context, epoch, block: next - 1n, pruneBlock: next > 15n ? next - 15n : 1n, contracts: sequenceContracts }
}
function activation(block: bigint, jobId: bigint, agentId = 1n, feeBps = 1000n): EpochChainRecord {
  const fee = (100000000n * feeBps) / 10000n
  return {
    eventName: 'Activated',
    block,
    logIndex: 0,
    tx,
    holding: account,
    jobId,
    worker,
    agentId,
    feeBps,
    fee,
    net: 100000000n - fee,
    workerBond: 3n,
  }
}
function settlement(block: bigint, jobId: bigint, amount = 10000000n, bonusPart = 0n): EpochChainRecord[] {
  return [
    {
      eventName: 'RewardSettled',
      block,
      logIndex: 0,
      tx,
      holding: account,
      jobId,
      to: worker,
      outcome: 1,
      amount: 90000000n,
    },
    {
      eventName: 'FeeCharged',
      block,
      logIndex: 1,
      tx,
      holding: account,
      jobId,
      token,
      worker,
      creator: backer,
      amount,
      bonusPart,
    },
  ]
}
function sequenceHistory(): EpochChainRecord[] {
  return [
    {
      eventName: 'ScheduleExecuted',
      block: 1n,
      logIndex: 0,
      tx,
      thresholds: [0n, 10000n * side, 100000n * side, 1000000n * side],
      bps: [3000n, 1000n, 300n, 100n],
      treasury: backer,
    },
    {
      eventName: 'Delegated',
      block: 2n,
      logIndex: 0,
      account: worker,
      delegator: backer,
      assets: 10000n * side,
      shares: 10000n * side,
    },
    {
      eventName: 'MetadataSet',
      block: 3n,
      logIndex: 0,
      tx,
      agentId: 1n,
      key: 'sidequest.backerShareBps',
      value: `0x${5000n.toString(16).padStart(64, '0')}`,
    },
    activation(11n, 1n),
    activation(12n, 2n),
    {
      eventName: 'ToppedUp',
      block: 13n,
      logIndex: 0,
      tx,
      holding: account,
      jobId: 1n,
      contributor: backer,
      amount: 10000000n,
      bonus: 10000000n,
    },
    {
      eventName: 'MetadataSet',
      block: 14n,
      logIndex: 0,
      tx,
      agentId: 1n,
      key: 'sidequest.backerShareBps',
      value: `0x${1000n.toString(16).padStart(64, '0')}`,
    },
    ...settlement(15n, 1n, 11000000n, 1000000n),
    {
      eventName: 'ToppedUp',
      block: 18n,
      logIndex: 0,
      tx,
      holding: account,
      jobId: 2n,
      contributor: backer,
      amount: 20000000n,
      bonus: 20000000n,
    },
    { eventName: 'EpochFunded', block: 20n, logIndex: 0, epoch: 0n, amount: 100n * side, totalFunded: 100n * side },
    {
      eventName: 'ScheduleExecuted',
      block: 24n,
      logIndex: 0,
      tx,
      thresholds: [0n, 5000n * side, 50000n * side, 500000n * side],
      bps: [2800n, 900n, 250n, 50n],
      treasury: backer,
    },
    {
      eventName: 'ToppedUp',
      block: 25n,
      logIndex: 0,
      tx,
      holding: account,
      jobId: 2n,
      contributor: worker,
      amount: 30000000n,
      bonus: 50000000n,
    },
    { eventName: 'Slashed', block: 32n, logIndex: 0, account: worker, amount: 10000n * side },
    { eventName: 'PoolReset', block: 32n, logIndex: 1, account: worker, generation: 1n },
    {
      eventName: 'Delegated',
      block: 33n,
      logIndex: 0,
      account: worker,
      delegator: backer,
      assets: 10000n * side,
      shares: 10000n * side,
    },
    ...settlement(34n, 2n, 15000000n, 5000000n),
    { eventName: 'EpochFunded', block: 40n, logIndex: 0, epoch: 2n, amount: 200n * side, totalFunded: 300n * side },
    activation(41n, 3n, 2n, 900n),
    ...settlement(45n, 3n, 9000000n),
  ]
}
const sequenceEvents = [
  ...ledgerHoldingEvents,
  ...stakeVaultEvents,
  scheduleExecutedEvent,
  fundedEvent,
  metadataSetEvent,
]
function sequenceLog(record: EpochChainRecord) {
  const event = sequenceEvents.find((candidate) => candidate.name === record.eventName)
  if (event === undefined) throw new Error('sequence ABI missing')
  const emitter =
    record.eventName === 'ScheduleExecuted'
      ? token
      : record.eventName === 'MetadataSet'
        ? backer
        : record.eventName === 'EpochFunded'
          ? token
          : 'holding' in record
            ? record.holding
            : worker
  const args: Record<string, unknown> = {
    ...record,
    payer: worker,
    selectionNonce: 1n,
    indexedMetadataKey: 'sidequest.backerShareBps',
    metadataKey: 'sidequest.backerShareBps',
    metadataValue: record.eventName === 'MetadataSet' ? record.value : '0x',
    holding: account,
  }
  const parameters = event.inputs.filter((p) => !p.indexed)
  // SAFETY: The typed sequence records above supply every field required by their event's ABI.
  const data = encodeAbiParameters(parameters, parameters.map((p) => args[p.name ?? '']) as never)
  return {
    address: emitter,
    blockNumber: `0x${record.block.toString(16)}`,
    blockHash: tx,
    logIndex: `0x${record.logIndex.toString(16)}`,
    transactionIndex: '0x0',
    transactionHash: tx,
    removed: false,
    data,
    topics: encodeEventTopics({ abi: [event], eventName: event.name, args }),
  }
}
function sequenceReader() {
  const logs = sequenceHistory().map(sequenceLog),
    ranges: [bigint, bigint][] = []
  const c = createPublicClient({
    transport: custom(
      {
        request: async ({ method, params }) => {
          if (method !== 'eth_getLogs') throw new Error('unexpected sequence RPC call')
          // SAFETY: viem constructs this log filter; the transport only receives eth_getLogs requests.
          const filter = params?.[0] as {
            fromBlock: Hex
            toBlock: Hex
            address: Address | Address[]
            topics: (string | string[] | null)[]
          }
          const addresses = Array.isArray(filter.address) ? filter.address : [filter.address]
          return logs
            .filter(
              (log) =>
                BigInt(log.blockNumber) >= BigInt(filter.fromBlock) &&
                BigInt(log.blockNumber) <= BigInt(filter.toBlock) &&
                addresses.includes(log.address) &&
                filter.topics.every(
                  (topic, i) =>
                    topic === null || (Array.isArray(topic) ? topic : [topic]).includes(log.topics[i] ?? ''),
                ),
            )
            .toReversed()
        },
      },
      { retryCount: 0 },
    ),
  })
  return {
    ranges,
    read: async (fromBlock: bigint, toBlock: bigint) => {
      ranges.push([fromBlock, toBlock])
      return readLedgerChain({
        c,
        holdings: [account],
        vault: worker,
        identity: backer,
        feeSchedule: token,
        reserve: token,
        fromBlock,
        toBlock,
        pager: { page: 7n },
      })
    },
  }
}
async function sequenceEpoch(input: { epoch: bigint; dir: string; roots: Map<bigint, Hex>; fromGenesis: boolean }) {
  const ctx = sequenceContext(input.epoch),
    fromBlock = 10n + input.epoch * 10n,
    reader = sequenceReader()
  const prepared = await prepareCheckpointReplay({
    epoch: input.epoch,
    fromEpoch: 0n,
    fromBlock,
    toBlock: ctx.block,
    genesisBlock: 1n,
    chainId: 10143,
    rule: sequenceRule,
    contracts: stateContractsOf(sequenceContracts),
    checkpointDir: input.dir,
    fromGenesis: input.fromGenesis,
    reader: { readRoot: async (epoch) => ({ dataHash: input.roots.get(epoch) ?? zero }), blockHash: async () => tx },
    stateContext: async (epoch) => sequenceContext(epoch),
    readRecords: reader.read,
  })
  const replay = replayEpochLedger(prepared.records, fromBlock, ctx.block, prepared.ledger)
  const shareBlock = fromBlock > 15n ? fromBlock - 15n : 1n
  const prices = { epoch: input.epoch, tokens: [{ token, decimals: 6, usdPrice: side }], factoryUsdPrice: 10n ** 15n }
  const computed = computeLedgerEpoch(replay, prices, 10n ** 30n, shareBlock, fromBlock),
    state = stateOf(replay.ledger, ctx)
  const inputs = inputsV2Of({
    chainId: 10143,
    epoch: input.epoch,
    rule: sequenceRule,
    window: {
      start: String(fromBlock),
      end: String(ctx.block + 1n),
      fromBlock: String(fromBlock),
      toBlock: String(ctx.block),
      toBlockHash: tx,
    },
    shareWindow: { start: String(shareBlock), block: String(shareBlock) },
    holdings: [account],
    priceList: {
      message: {
        epoch: String(input.epoch),
        tokens: [{ token, decimals: 6, usdPrice: String(side) }],
        factoryUsdPrice: String(prices.factoryUsdPrice),
      },
      signer: backer,
      signature: `0x${'ab'.repeat(65)}`,
    },
    factoryPriceEvidence: { previousSignedPrice: null },
    budget: { available: String(10n ** 30n) },
    feeSchedules: replay.end.feeSchedules,
    fees: computed.result.fees,
    topUps: computed.topUps,
    backing: computed.stakes,
    backerShares: computed.shares,
    backerPositions: computed.result.backerPositions,
    checkpoint: { previous: prepared.previous, stateHash: stateHashOf(state) },
  })
  const tree = computed.result.leaves.length === 0 ? null : buildTree(leafValues(input.epoch, computed.result.leaves))
  const claims: Record<string, { amount: string; proof: Hex[] }> = {}
  tree?.values.forEach((entry, i) => {
    claims[entry.value[1]] = { amount: entry.value[2], proof: proofOf(tree, i) }
  })
  const artifact = {
    rule: 2,
    chainId: 10143,
    epoch: String(input.epoch),
    inputs,
    dataHash: dataHashOf(inputs),
    tree,
    claims,
    root: tree?.tree[0] ?? null,
    total: String(computed.result.total),
  }
  return { artifact, state, replay, ranges: reader.ranges, computed }
}

test('incremental epochs equal genesis byte for byte through empty, schedule, reset, cut and delayed-settlement history', async () => {
  const dir = directory(),
    roots = new Map<bigint, Hex>()
  try {
    for (let epoch = 0n; epoch < 4n; epoch++) {
      const incremental = await sequenceEpoch({ epoch, dir, roots, fromGenesis: false })
      const genesis = await sequenceEpoch({ epoch, dir: '/missing-audit-directory', roots, fromGenesis: true })
      expect(JSON.stringify(incremental.artifact)).toBe(JSON.stringify(genesis.artifact))
      expect(JSON.stringify(incremental.state)).toBe(JSON.stringify(genesis.state))
      expect(firstEpochDiff(incremental.artifact, rebuildRecorded(incremental.artifact))).toBeNull()
      if (epoch === 0n) {
        expect(incremental.artifact.inputs.checkpoint?.previous).toBeNull()
        expect(incremental.state.activations.map((a) => a.jobId)).toEqual(['2'])
        expect(incremental.state.topUps.map((t) => t.jobId)).toEqual(['2'])
        expect(incremental.computed.shares[0]?.bps).toBe(5000n)
      }
      if (epoch === 1n) expect(incremental.artifact.root).toBeNull()
      if (epoch === 2n) {
        expect(incremental.artifact.inputs.checkpoint?.previous?.epoch).toBe('0')
        expect(incremental.ranges).toEqual([[20n, 39n]])
        expect(incremental.state.activations).toEqual([])
        expect(incremental.state.topUps).toEqual([])
        expect(incremental.computed.shares[0]?.bps).toBe(1000n)
        expect(incremental.computed.result.backerPositions).toEqual([])
        expect(incremental.computed.result.fees[0]?.credit?.activation.block).toBe(12n)
        expect(incremental.computed.result.fees[0]?.credit?.lowestBps).toBe(100n)
      }
      if (epoch === 3n) {
        expect(incremental.artifact.inputs.checkpoint?.previous?.epoch).toBe('2')
        expect(incremental.ranges).toEqual([[40n, 49n]])
        expect(incremental.state.wallets[0]?.agentIds).toEqual(['1', '2'])
        expect(incremental.computed.result.fees[0]?.credit?.lowestBps).toBe(50n)
      }
      writeFileSync(join(dir, `epoch-${epoch}.json`), JSON.stringify(incremental.artifact))
      writeFileSync(join(dir, `state-${epoch}.json`), JSON.stringify(incremental.state))
      if (incremental.artifact.root !== null) roots.set(epoch, incremental.artifact.dataHash)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
