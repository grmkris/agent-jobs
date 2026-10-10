import { expect, test } from 'bun:test'
import { activatedEvent, metadataSetEvent, stakeVaultEvents } from './backers-chain.ts'
import { BACKER_SHARE_KEY } from './backers.ts'
import { readLedgerChain, ledgerHoldingEvents, scheduleExecutedEvent, fundedEvent } from './ledger-chain.ts'
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  type AbiEvent,
  type Address,
} from './viem.ts'

const holding = '0x0000000000000000000000000000000000000001'
const vault = '0x0000000000000000000000000000000000000002'
const feeSchedule = '0x0000000000000000000000000000000000000003'
const reserve = '0x0000000000000000000000000000000000000004'
const identity = '0x0000000000000000000000000000000000000005'
const worker = '0x0000000000000000000000000000000000000006'
const tx = `0x${'ab'.repeat(32)}` as const

function rawLog(event: AbiEvent, args: Record<string, unknown>, address: Address, block: bigint, logIndex = 0) {
  const parameters = event.inputs.filter((input) => !input.indexed)
  // SAFETY: Each test call supplies the values for exactly this event's ABI inputs in ABI order.
  const data = encodeAbiParameters(parameters, parameters.map((input) => args[input.name ?? '']) as never)
  return {
    address,
    blockNumber: `0x${block.toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    blockHash: tx,
    transactionHash: tx,
    transactionIndex: '0x0',
    removed: false,
    data,
    topics: encodeEventTopics({ abi: [event], eventName: event.name, args }),
  }
}
const eventOf = (name: string) => {
  const found = [
    ...stakeVaultEvents,
    ...ledgerHoldingEvents,
    scheduleExecutedEvent,
    fundedEvent,
    metadataSetEvent,
  ].find((event) => event.name === name)
  if (found === undefined) throw new Error('test event missing')
  return found
}
const rawHistory = () => [
  rawLog(
    scheduleExecutedEvent,
    { thresholds: [0n, 10n, 100n, 1000n], bps: [3000, 1000, 300, 100], treasury: worker },
    feeSchedule,
    1n,
  ),
  rawLog(
    eventOf('Delegated'),
    { account: worker, delegator: worker, payer: worker, assets: 100n, shares: 100n },
    vault,
    2n,
  ),
  rawLog(
    metadataSetEvent,
    { agentId: 1n, indexedMetadataKey: BACKER_SHARE_KEY, metadataKey: BACKER_SHARE_KEY, metadataValue: '0x1234' },
    identity,
    3n,
  ),
  rawLog(
    metadataSetEvent,
    { agentId: 1n, indexedMetadataKey: 'another.key', metadataKey: 'another.key', metadataValue: '0xab' },
    identity,
    3n,
    1,
  ),
  rawLog(
    activatedEvent,
    { jobId: 1n, worker, agentId: 1n, selectionNonce: 1n, feeBps: 300, fee: 3n, net: 97n, workerBond: 0n },
    holding,
    4n,
  ),
  rawLog(eventOf('ToppedUp'), { jobId: 1n, contributor: worker, amount: 10n, bonus: 10n }, holding, 5n),
  rawLog(
    eventOf('FeeCharged'),
    { jobId: 1n, token: reserve, worker, creator: identity, amount: 4n, bonusPart: 1n },
    holding,
    6n,
  ),
  rawLog(eventOf('PayoutOwed'), { jobId: 1n, to: worker, token: reserve, amount: 4n }, holding, 6n, 1),
  rawLog(eventOf('OwedWithdrawn'), { to: worker, token: reserve, amount: 4n }, holding, 6n, 2),
  rawLog(eventOf('RewardSettled'), { jobId: 1n, to: worker, outcome: 1, amount: 107n }, holding, 6n, 3),
  rawLog(fundedEvent, { epoch: 1n, amount: 100n, totalFunded: 100n }, reserve, 7n),
  rawLog(
    eventOf('UndelegateRequested'),
    { account: worker, delegator: worker, shares: 10n, assets: 10n, queuedShares: 10n, unlockAt: 1000 },
    vault,
    8n,
  ),
  rawLog(eventOf('UndelegateCancelled'), { account: worker, delegator: worker, shares: 10n, assets: 10n }, vault, 9n),
  rawLog(eventOf('Slashed'), { holding, account: worker, amount: 1n }, vault, 10n),
  rawLog(eventOf('Forfeited'), { holding, account: worker, to: identity, amount: 1n }, vault, 10n, 1),
  rawLog(eventOf('PoolReset'), { account: worker, generation: 1n }, vault, 11n),
  rawLog(eventOf('Withdrawn'), { account: worker, delegator: worker, shares: 10n, assets: 9n }, vault, 12n),
]
type Filter = { fromBlock: string; toBlock: string; address: string | string[]; topics: (string | string[] | null)[] }
const matches = (log: ReturnType<typeof rawLog>, filter: Filter) => {
  const addresses = Array.isArray(filter.address) ? filter.address : [filter.address]
  const block = BigInt(log.blockNumber)
  return (
    block >= BigInt(filter.fromBlock) &&
    block <= BigInt(filter.toBlock) &&
    addresses.map((address) => address.toLowerCase()).includes(log.address.toLowerCase()) &&
    filter.topics.every(
      (topic, i) => topic === null || (Array.isArray(topic) ? topic : [topic]).includes(log.topics[i] ?? ''),
    )
  )
}

function reader(maxSpan = 100n) {
  const requests: Filter[] = []
  const logs = rawHistory()
  const c = createPublicClient({
    transport: custom(
      {
        request: async ({ method, params }) => {
          if (method !== 'eth_getLogs') throw new Error('unexpected non-log call')
          // SAFETY: viem creates this JSON-RPC log-filter shape; this unit transport consumes only eth_getLogs.
          const filter = params?.[0] as Filter
          requests.push(filter)
          if (BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n > maxSpan)
            throw new Error('block range', { cause: { code: -32005 } })
          return logs.filter((log) => matches(log, filter)).toReversed()
        },
      },
      { retryCount: 0 },
    ),
  })
  return { c, requests }
}

test('combined replay history includes every required event and filters only the backer metadata key', async () => {
  const { c, requests } = reader()
  const records = await readLedgerChain({
    c,
    holdings: [holding],
    vault,
    feeSchedule,
    reserve,
    identity,
    fromBlock: 1n,
    toBlock: 12n,
    pager: { page: 100n },
  })
  expect(records.map((record) => record.eventName)).toEqual([
    'ScheduleExecuted',
    'Delegated',
    'MetadataSet',
    'Activated',
    'ToppedUp',
    'FeeCharged',
    'PayoutOwed',
    'OwedWithdrawn',
    'RewardSettled',
    'EpochFunded',
    'UndelegateRequested',
    'UndelegateCancelled',
    'Slashed',
    'Forfeited',
    'PoolReset',
    'Withdrawn',
  ])
  expect(records.find((record) => record.eventName === 'Activated')).toMatchObject({ feeBps: 300n, worker })
  expect(records.find((record) => record.eventName === 'MetadataSet')).toMatchObject({
    key: BACKER_SHARE_KEY,
    value: '0x1234',
  })
  expect(requests).toHaveLength(5)
  const metadata = requests.find((request) => request.address === identity)
  expect(metadata?.topics[2]).toBe(
    encodeEventTopics({
      abi: [metadataSetEvent],
      eventName: 'MetadataSet',
      args: { indexedMetadataKey: BACKER_SHARE_KEY },
    })[2],
  )
})

test('range reduction is shared across holdings, vault, schedule, funding and identity reads', async () => {
  const { c, requests } = reader(2n)
  const pager = { page: 8n }
  const records = await readLedgerChain({
    c,
    holdings: [holding],
    vault,
    feeSchedule,
    reserve,
    identity,
    fromBlock: 1n,
    toBlock: 12n,
    pager,
  })
  expect(records).toHaveLength(16)
  expect(pager.page).toBe(2n)
  expect(requests.slice(2).every((request) => BigInt(request.toBlock) - BigInt(request.fromBlock) + 1n <= 2n)).toBe(
    true,
  )
})

test('empty ranges read no logs', async () => {
  const { c, requests } = reader()
  expect(
    await readLedgerChain({
      c,
      holdings: [holding],
      vault,
      feeSchedule,
      reserve,
      identity,
      fromBlock: 2n,
      toBlock: 1n,
      pager: { page: 1n },
    }),
  ).toEqual([])
  expect(requests).toEqual([])
})
