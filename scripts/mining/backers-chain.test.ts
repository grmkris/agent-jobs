import { expect, test } from 'bun:test'
import { activatedEvent, metadataSetEvent, readBackerWorkers, stakeVaultEvents } from './backers-chain.ts'
import { BACKER_SHARE_KEY } from './backers.ts'
import { computeEpoch, type FeeCharged } from './compute.ts'
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toBytes,
  type AbiEvent,
  type Hex,
} from './viem.ts'

const identity = '0x0000000000000000000000000000000000000001'
const vault = '0x0000000000000000000000000000000000000002'
const holding = '0x0000000000000000000000000000000000000003'
const worker = '0x0000000000000000000000000000000000000004'
const backer = '0x0000000000000000000000000000000000000005'
const tx = `0x${'11'.repeat(32)}` as const
const fee: FeeCharged = {
  block: 12n,
  logIndex: 1,
  tx,
  holding,
  jobId: 1n,
  token: holding,
  worker,
  creator: backer,
  amount: 100n,
  bonusPart: 0n,
}
const logOf = (
  event: AbiEvent,
  address: string,
  block: number,
  args: Record<string, bigint | number | string>,
  logIndex = 0,
) => {
  const params = event.inputs.filter((p) => !p.indexed)
  const values = params.map((p) => {
    if (p.name === undefined) throw new Error('fixture ABI parameter missing its name')
    const value = args[p.name]
    if (value === undefined) throw new Error('fixture ABI argument missing')
    return value
  })
  return {
    address,
    blockNumber: `0x${block.toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    transactionHash: tx,
    blockHash: tx,
    transactionIndex: '0x0',
    removed: false,
    topics: encodeEventTopics({ abi: [event], args }),
    data: encodeAbiParameters(params, values),
  }
}
const metadataLog = (block: number, bps: bigint) =>
  logOf(metadataSetEvent, identity, block, {
    agentId: 1n,
    indexedMetadataKey: BACKER_SHARE_KEY,
    metadataKey: BACKER_SHARE_KEY,
    metadataValue: encodeAbiParameters([{ type: 'uint256' }], [bps]),
  })
const activationLog = logOf(activatedEvent, holding, 6, {
  jobId: 1n,
  worker,
  agentId: 1n,
  selectionNonce: 1n,
  feeBps: 3000,
  fee: 1n,
  net: 1n,
  workerBond: 0n,
})
const delegated = stakeVaultEvents[0]
const logs = [
  metadataLog(8, 5000n),
  metadataLog(10, 10000n),
  activationLog,
  logOf(delegated, vault, 5, { account: worker, delegator: backer, payer: worker, assets: 100n, shares: 100n }),
  logOf(stakeVaultEvents[1], vault, 20, {
    account: worker,
    delegator: backer,
    shares: 30n,
    assets: 30n,
    queuedShares: 30n,
    unlockAt: 100,
  }),
]
interface Filter {
  address: string | string[]
  fromBlock: Hex
  toBlock: Hex
  topics: (Hex | Hex[] | null)[]
}
function rpcFixture(events = logs, maxPage = 100n) {
  const requests: Filter[] = []
  const c = createPublicClient({
    transport: custom(
      {
        request: async ({ method, params }) => {
          if (method !== 'eth_getLogs') throw new Error(`unexpected RPC method ${method}`)
          // SAFETY: viem's getLogs is the sole caller; it supplies one standard eth_getLogs filter.
          const [filter] = params as [Filter]
          requests.push(filter)
          if (BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n > maxPage)
            throw Object.assign(new Error('block range refused'), { code: -32005 })
          const addresses = Array.isArray(filter.address) ? filter.address : [filter.address]
          return events
            .filter(
              (event) =>
                addresses.includes(event.address) &&
                BigInt(event.blockNumber) >= BigInt(filter.fromBlock) &&
                BigInt(event.blockNumber) <= BigInt(filter.toBlock) &&
                filter.topics.every(
                  (topic, index) =>
                    topic === null ||
                    (Array.isArray(topic)
                      ? topic.some((value) => value === event.topics[index])
                      : topic === event.topics[index]),
                ),
            )
            .toReversed()
        },
      },
      { retryCount: 0 },
    ),
  })
  return { c, requests }
}
const input: Omit<Parameters<typeof readBackerWorkers>[0], 'c'> = {
  identity,
  vault,
  holdings: [holding],
  fees: [fee],
  deploymentBlock: 5n,
  fromBlock: 10n,
  toBlock: 20n,
  page: 1000n,
}

test('real viem topics and decoders read only pre-window metadata, activation history and event-only endpoints', async () => {
  const f = rpcFixture()
  const workers = await readBackerWorkers({ ...input, c: f.c })
  expect(workers[0]).toMatchObject({
    worker,
    agentId: 1n,
    bps: 5000n,
    set: { block: 8n, logIndex: 0, tx },
    positions: [{ account: worker, delegator: backer, start: 100n, end: 70n, weight: 70n }],
  })
  const metadataRequests = f.requests.filter((r) => r.address === identity)
  expect(metadataRequests.at(-1)?.toBlock).toBe('0x9')
  expect(metadataRequests[0]?.topics[2]).toBe(keccak256(toBytes(BACKER_SHARE_KEY)))
  expect(f.requests.every((r) => BigInt(r.fromBlock) >= 5n)).toBe(true)
  const result = computeEpoch({
    fees: [fee],
    owed: [],
    withdrawals: [],
    prices: {
      epoch: 0n,
      tokens: [{ token: holding, decimals: 18, usdPrice: 10n ** 18n }],
      factoryUsdPrice: 10n ** 18n,
    },
    budget: 100n,
    backerWorkers: workers,
  })
  expect(result.leaves).toEqual([
    { account: worker, amount: 15n },
    { account: backer, amount: 35n },
  ])
})

test('all three histories halve refused pages, retry the same range, and still reproduce endpoints', async () => {
  const f = rpcFixture(logs, 2n)
  const workers = await readBackerWorkers({ ...input, page: 8n, c: f.c })
  expect(workers[0]?.positions[0]).toMatchObject({ start: 100n, end: 70n, weight: 70n })
  const pages = f.requests.filter((r) => r.address === vault)
  expect(pages.slice(0, 3).map((p) => [p.fromBlock, p.toBlock])).toEqual([
    ['0x5', '0xc'],
    ['0x5', '0x8'],
    ['0x5', '0x6'],
  ])
  const metadataPages = f.requests.filter((r) => r.address === identity)
  expect(metadataPages.every((r) => BigInt(r.toBlock) < 10n)).toBe(true)
})

test('opt-out epochs skip the vault replay, and missing activations do not read current registry state', async () => {
  const f = rpcFixture([metadataLog(8, 0n), activationLog])
  expect((await readBackerWorkers({ ...input, c: f.c }))[0]?.bps).toBe(0n)
  expect(f.requests.some((r) => r.address === vault)).toBe(false)
  const missing = rpcFixture([metadataLog(8, 5000n)])
  expect((await readBackerWorkers({ ...input, c: missing.c }))[0]?.bps).toBe(0n)
  expect(missing.requests.some((r) => r.address === vault)).toBe(false)
})

test('empty epochs perform no backer reads', async () => {
  const f = rpcFixture()
  expect(await readBackerWorkers({ ...input, fees: [], c: f.c })).toEqual([])
  expect(await readBackerWorkers({ ...input, fromBlock: 21n, c: f.c })).toEqual([])
  expect(f.requests).toHaveLength(0)
})
