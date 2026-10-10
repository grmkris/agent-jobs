import { activatedEvent, metadataSetEvent, stakeVaultEvents } from './backers-chain.ts'
import { BACKER_SHARE_KEY } from './backers.ts'
import { holdingEvents, pagedLogs, type LogPager } from './chain.ts'
import type { FeeCharged, OwedWithdrawn, PayoutOwed } from './compute.ts'
import { chainOrder } from './credit.ts'
import type { LedgerRecord } from './ledger.ts'
import { parseAbiItem, type Address, type Hex, type PublicClient } from './viem.ts'

export const ledgerHoldingEvents = [
  activatedEvent,
  parseAbiItem('event ToppedUp(uint256 indexed jobId, address indexed contributor, uint256 amount, uint256 bonus)'),
  ...holdingEvents,
  parseAbiItem('event RewardSettled(uint256 indexed jobId, address indexed to, uint8 outcome, uint256 amount)'),
] as const
export const scheduleExecutedEvent = parseAbiItem(
  'event ScheduleExecuted(uint256[4] thresholds, uint16[4] bps, address treasury)',
)
export const fundedEvent = parseAbiItem('event EpochFunded(uint256 indexed epoch, uint256 amount, uint256 totalFunded)')

export type EpochChainRecord =
  | LedgerRecord
  | (FeeCharged & { eventName: 'FeeCharged' })
  | (PayoutOwed & { eventName: 'PayoutOwed' })
  | (OwedWithdrawn & { eventName: 'OwedWithdrawn' })
  | {
      eventName: 'RewardSettled'
      block: bigint
      logIndex: number
      tx: Hex
      holding: Address
      jobId: bigint
      to: Address
      outcome: number
      amount: bigint
    }

// SAFETY: All callers supply decoded ABI addresses, so normalization preserves their shape.
export const lower = (value: Address): Address => value.toLowerCase() as Address

async function readHoldings(c: PublicClient, holdings: Address[], from: bigint, to: bigint, pager: LogPager) {
  if (holdings.length === 0) return []
  const logs = await pagedLogs(from, to, pager, (fromBlock, toBlock) =>
    c.getLogs({ address: holdings, events: ledgerHoldingEvents, fromBlock, toBlock, strict: true }),
  )
  return logs.map((log): EpochChainRecord => {
    const base = {
      block: log.blockNumber,
      logIndex: log.logIndex,
      tx: log.transactionHash,
      holding: lower(log.address),
    }
    const eventName = log.eventName
    switch (eventName) {
      case 'Activated':
        return { ...base, ...log.args, worker: lower(log.args.worker), feeBps: BigInt(log.args.feeBps), eventName }
      case 'ToppedUp':
        return { ...base, ...log.args, contributor: lower(log.args.contributor), eventName }
      case 'FeeCharged':
        return {
          ...base,
          ...log.args,
          token: lower(log.args.token),
          worker: lower(log.args.worker),
          creator: lower(log.args.creator),
          eventName,
        }
      case 'PayoutOwed':
        return { ...base, ...log.args, to: lower(log.args.to), token: lower(log.args.token), eventName }
      case 'OwedWithdrawn':
        return { ...base, ...log.args, to: lower(log.args.to), token: lower(log.args.token), eventName }
      case 'RewardSettled':
        return { ...base, ...log.args, to: lower(log.args.to), eventName }
    }
  })
}

async function readVault(c: PublicClient, vault: Address, from: bigint, to: bigint, pager: LogPager) {
  const logs = await pagedLogs(from, to, pager, (fromBlock, toBlock) =>
    c.getLogs({ address: vault, events: stakeVaultEvents, fromBlock, toBlock, strict: true }),
  )
  return logs.map((log): LedgerRecord => {
    const base = { block: log.blockNumber, logIndex: log.logIndex, account: lower(log.args.account) }
    const eventName = log.eventName
    switch (eventName) {
      case 'Delegated':
      case 'Withdrawn':
        return { ...base, ...log.args, delegator: lower(log.args.delegator), eventName }
      case 'UndelegateRequested':
        return { ...base, ...log.args, delegator: lower(log.args.delegator), eventName }
      case 'UndelegateCancelled':
        return { ...base, ...log.args, delegator: lower(log.args.delegator), eventName }
      case 'Slashed':
      case 'Forfeited':
        return { ...base, amount: log.args.amount, eventName }
      case 'PoolReset':
        return { ...base, generation: log.args.generation, eventName }
    }
  })
}

export interface LedgerChainInput {
  c: PublicClient
  holdings: Address[]
  vault: Address
  feeSchedule: Address
  reserve: Address
  identity: Address
  fromBlock: bigint
  toBlock: bigint
  pager: LogPager
}

/** Every log query shares the same shrinking pager and the zero-retry log client supplied by the runner. */
export async function readLedgerChain(input: LedgerChainInput): Promise<EpochChainRecord[]> {
  const { c, holdings, vault, feeSchedule, reserve, identity, fromBlock: from, toBlock: to, pager } = input
  const records: EpochChainRecord[] = await readHoldings(c, holdings, from, to, pager)
  records.push(...(await readVault(c, vault, from, to, pager)))
  const schedules = await pagedLogs(from, to, pager, (fromBlock, toBlock) =>
    c.getLogs({ address: feeSchedule, event: scheduleExecutedEvent, fromBlock, toBlock, strict: true }),
  )
  for (const log of schedules)
    records.push({
      eventName: 'ScheduleExecuted',
      block: log.blockNumber,
      logIndex: log.logIndex,
      tx: log.transactionHash,
      ...log.args,
      bps: log.args.bps.map(BigInt),
      treasury: lower(log.args.treasury),
    })
  const funding = await pagedLogs(from, to, pager, (fromBlock, toBlock) =>
    c.getLogs({ address: reserve, event: fundedEvent, fromBlock, toBlock, strict: true }),
  )
  for (const log of funding)
    records.push({
      eventName: 'EpochFunded',
      block: log.blockNumber,
      logIndex: log.logIndex,
      tx: log.transactionHash,
      ...log.args,
    })
  const metadata = await pagedLogs(from, to, pager, (fromBlock, toBlock) =>
    c.getLogs({
      address: identity,
      event: metadataSetEvent,
      args: { indexedMetadataKey: BACKER_SHARE_KEY },
      fromBlock,
      toBlock,
      strict: true,
    }),
  )
  for (const log of metadata)
    records.push({
      eventName: 'MetadataSet',
      block: log.blockNumber,
      logIndex: log.logIndex,
      tx: log.transactionHash,
      agentId: log.args.agentId,
      key: log.args.metadataKey,
      // SAFETY: The ABI decoder returns bytes hex; case normalization preserves the bytes32/bytes shape.
      value: log.args.metadataValue.toLowerCase() as Hex,
    }) // SAFETY: Decoded ABI bytes remain valid hex after normalization.
  return records.toSorted(chainOrder)
}

export function isLedgerRecord(record: EpochChainRecord): record is LedgerRecord {
  return (
    record.eventName !== 'FeeCharged' &&
    record.eventName !== 'PayoutOwed' &&
    record.eventName !== 'OwedWithdrawn' &&
    record.eventName !== 'RewardSettled'
  )
}
