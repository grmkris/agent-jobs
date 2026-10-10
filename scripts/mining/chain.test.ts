import { expect, test } from 'bun:test'
import { isRangeError, logClient, pagedLogs, type LogPager } from './chain.ts'
import { activatedEvent, metadataSetEvent, readBackerWorkers, stakeVaultEvents } from './backers-chain.ts'
import {
  BACKER_SHARE_KEY,
  backerInputs,
  replayVaultEvents,
  resolveBackerWorkers,
  type VaultEventRecord,
} from './backers.ts'
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, type AbiEvent, type Hex } from './viem.ts'
import type { FeeCharged } from './compute.ts'

const blocks = (from: bigint, to: bigint) => {
  const out: bigint[] = []
  for (let block = from; block <= to; block++) out.push(block)
  return out
}

async function rejectionOf<T>(promise: Promise<T>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error('unexpected rejection value', { cause: error })
  }
  throw new Error('expected the request to reject')
}

test('range detection follows causes, recognizes RPC/HTTP codes and messages, and terminates cycles', () => {
  for (const cause of [
    { code: -32005 },
    { code: -32602 },
    { code: -32614 },
    { status: 413 },
    { statusCode: 413 },
    ...['block range', 'limit hit', 'too many results', 'exceeded request size', 'maximum 100 blocks'].map(
      (message) => ({ message }),
    ),
  ])
    expect(isRangeError(new Error('provider refused', { cause: new Error('request failed', { cause }) }))).toBe(true)
  expect(isRangeError(new Error('timeout'))).toBe(false)
  expect(isRangeError({ code: 429, message: 'temporarily unavailable' })).toBe(false)
  const cyclic: { cause?: object } = {}
  cyclic.cause = cyclic
  expect(isRangeError(cyclic)).toBe(false)
})

test('range refusals shrink immediately and never grow back, preserving the returned logs', async () => {
  const requests: [bigint, bigint][] = []
  const pager: LogPager = { page: 8n }
  const result = await pagedLogs(1n, 10n, pager, async (from, to) => {
    requests.push([from, to])
    if (to - from + 1n > 2n) throw new Error('refused', { cause: { code: -32005 } })
    return blocks(from, to)
  })
  expect(requests).toEqual([
    [1n, 8n],
    [1n, 4n],
    [1n, 2n],
    [3n, 4n],
    [5n, 6n],
    [7n, 8n],
    [9n, 10n],
  ])
  expect(result).toEqual(blocks(1n, 10n))
  expect(pager.page).toBe(2n)
  const next: [bigint, bigint][] = []
  expect(
    await pagedLogs(11n, 15n, pager, async (from, to) => {
      next.push([from, to])
      return blocks(from, to)
    }),
  ).toEqual(blocks(11n, 15n))
  expect(next).toEqual([
    [11n, 12n],
    [13n, 14n],
    [15n, 15n],
  ])
})

test('nonrange failures get exactly three retries without shrinking the request', async () => {
  const requests: [bigint, bigint][] = []
  const pager = { page: 8n }
  const result = await pagedLogs(1n, 8n, pager, async (from, to) => {
    requests.push([from, to])
    if (requests.length < 4) throw new Error('temporarily unavailable')
    return blocks(from, to)
  })
  expect(requests).toEqual(Array.from({ length: 4 }, () => [1n, 8n]))
  expect(pager.page).toBe(8n)
  expect(result).toEqual(blocks(1n, 8n))
})

test('exhausted nonrange errors throw unchanged after the fourth attempt', async () => {
  const failure = new Error('unauthorized')
  let calls = 0
  const pager = { page: 8n }
  expect(
    await rejectionOf(
      pagedLogs(1n, 8n, pager, async () => {
        calls++
        throw failure
      }),
    ),
  ).toBe(failure)
  expect(calls).toBe(4)
  expect(pager.page).toBe(8n)
})

test('a one-block range failure is never retried, and invalid or empty ranges make no calls', async () => {
  const failure = new Error('too many logs in one block')
  let calls = 0
  const fetch = async () => {
    calls++
    throw failure
  }
  expect(await rejectionOf(pagedLogs(1n, 1n, 1n, fetch))).toBe(failure)
  expect(calls).toBe(1)
  expect((await rejectionOf(pagedLogs(1n, 1n, 0n, fetch))).message).toContain('at least one block')
  expect(await pagedLogs(2n, 1n, 1n, fetch)).toEqual([])
  expect(calls).toBe(1)
})

test('the dedicated log transport disables its own retry loop', () => {
  // No request is made; the dummy URI only lets us inspect the local transport configuration.
  expect(logClient('http://127.0.0.1:1').transport.retryCount).toBe(0)
})

const identity = '0x0000000000000000000000000000000000000001'
const vault = '0x0000000000000000000000000000000000000002'
const holding = '0x0000000000000000000000000000000000000003'
const worker = '0x0000000000000000000000000000000000000004'
const other = '0x0000000000000000000000000000000000000005'
const backer = '0x0000000000000000000000000000000000000006'
const tx = `0x${'11'.repeat(32)}` as const
const fee: FeeCharged = {
  block: 20n,
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
interface Filter {
  address: string | string[]
  fromBlock: Hex
  toBlock: Hex
  topics: (Hex | Hex[] | null)[]
}
function eventLog(
  event: AbiEvent,
  address: string,
  block: number,
  args: Record<string, string | number | bigint>,
  logIndex = 0,
) {
  const params = event.inputs.filter((param) => !param.indexed)
  const values = params.map((param) => {
    const value = args[param.name ?? '']
    if (value === undefined) throw new Error('missing fixture event field')
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
function vaultFixture() {
  const raw = [
    eventLog(metadataSetEvent, identity, 4, {
      agentId: 1n,
      indexedMetadataKey: BACKER_SHARE_KEY,
      metadataKey: BACKER_SHARE_KEY,
      metadataValue: encodeAbiParameters([{ type: 'uint256' }], [5000n]),
    }),
    ...[worker, other].map((account, i) =>
      eventLog(
        activatedEvent,
        holding,
        5,
        {
          jobId: BigInt(i + 1),
          worker: account,
          agentId: BigInt(i + 1),
          selectionNonce: 0n,
          feeBps: 3000,
          fee: 1n,
          net: 1n,
          workerBond: 0n,
        },
        i,
      ),
    ),
    ...[worker, other].map((account, i) =>
      eventLog(
        stakeVaultEvents[0],
        vault,
        6,
        { account, delegator: backer, payer: backer, assets: 100n, shares: 100n },
        i,
      ),
    ),
    eventLog(stakeVaultEvents[5], vault, 7, { holding, account: worker, amount: 25n }),
    eventLog(stakeVaultEvents[6], vault, 8, { holding, account: worker, to: holding, amount: 75n }),
    eventLog(stakeVaultEvents[4], vault, 8, { account: worker, generation: 1n }, 1),
    eventLog(stakeVaultEvents[0], vault, 12, {
      account: worker,
      delegator: backer,
      payer: backer,
      assets: 50n,
      shares: 50n,
    }),
  ]
  const requests: Filter[] = []
  const c = createPublicClient({
    transport: custom(
      {
        request: async ({ method, params }) => {
          if (method !== 'eth_getLogs') throw new Error('unexpected fixture RPC method')
          // SAFETY: Only viem's getLogs calls this unit transport, with one standard log filter.
          const [filter] = params as [Filter]
          requests.push(filter)
          const addresses = Array.isArray(filter.address) ? filter.address : [filter.address]
          return raw
            .filter(
              (log) =>
                addresses.includes(log.address) &&
                BigInt(log.blockNumber) >= BigInt(filter.fromBlock) &&
                BigInt(log.blockNumber) <= BigInt(filter.toBlock) &&
                filter.topics.every(
                  (topic, i) =>
                    topic === null || (Array.isArray(topic) ? topic.includes(log.topics[i]) : topic === log.topics[i]),
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

test('v1 vault topic filters exclude zero-share workers and preserve canonical backer inputs', async () => {
  const fixture = vaultFixture()
  const fees = [fee, { ...fee, worker: other, jobId: 2n }]
  const actual = await readBackerWorkers({
    c: fixture.c,
    identity,
    vault,
    holdings: [holding],
    fees,
    deploymentBlock: 4n,
    fromBlock: 10n,
    toBlock: 20n,
    page: 100n,
  })
  const records: VaultEventRecord[] = [
    { block: 6n, logIndex: 0, account: worker, eventName: 'Delegated', delegator: backer, shares: 100n },
    { block: 6n, logIndex: 1, account: other, eventName: 'Delegated', delegator: backer, shares: 100n },
    { block: 8n, logIndex: 1, account: worker, eventName: 'PoolReset', generation: 1n },
    { block: 12n, logIndex: 0, account: worker, eventName: 'Delegated', delegator: backer, shares: 50n },
  ]
  const expected = resolveBackerWorkers({
    fees,
    activations: [worker, other].map((account, i) => ({
      block: 5n,
      logIndex: i,
      tx,
      holding,
      worker: account,
      jobId: BigInt(i + 1),
      agentId: BigInt(i + 1),
    })),
    metadata: [
      {
        block: 4n,
        logIndex: 0,
        tx,
        holding: identity,
        agentId: 1n,
        key: BACKER_SHARE_KEY,
        value: encodeAbiParameters([{ type: 'uint256' }], [5000n]),
      },
    ],
    positions: replayVaultEvents(records, 10n, 20n),
    fromBlock: 10n,
  })
  expect(backerInputs(actual)).toEqual(backerInputs(expected))
  const requests = fixture.requests.filter((request) => request.address === vault)
  expect(requests).toHaveLength(7)
  const accountTopic = encodeAbiParameters([{ type: 'address' }], [worker])
  expect(
    requests.slice(0, 5).every((request) => JSON.stringify(request.topics[1]) === JSON.stringify([accountTopic])),
  ).toBe(true)
  expect(
    requests.slice(5).every((request) => JSON.stringify(request.topics[2]) === JSON.stringify([accountTopic])),
  ).toBe(true)
  expect(actual.find((row) => row.worker === other)?.positions).toEqual([])
  expect(actual.find((row) => row.worker === worker)?.positions).toEqual([
    { account: worker, delegator: backer, start: 0n, end: 50n, weight: 0n },
  ])
})
