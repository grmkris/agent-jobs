import type { ActivationRecord, ChainPosition, ScheduleRecord } from './credit.ts'
import { chainOrder, rankOfFeeBps, rankOfStake, scheduleAt, validateScheduleV2 } from './credit.ts'
import type { FeeCharged } from './compute.ts'
import type { Address, Hex } from './viem.ts'

export interface PoolState {
  assets: bigint
  shares: bigint
  queued: bigint
  generation: bigint
}

export interface PositionState {
  account: Address
  delegator: Address
  shares: bigint
  queued: bigint
  generation: bigint
}

export type VaultRecord = ChainPosition & { account: Address } & (
    | {
        eventName: 'Delegated' | 'UndelegateCancelled' | 'Withdrawn'
        delegator: Address
        assets: bigint
        shares: bigint
      }
    | { eventName: 'UndelegateRequested'; delegator: Address; shares: bigint; assets: bigint; queuedShares: bigint }
    | { eventName: 'Slashed'; amount: bigint }
    | { eventName: 'Forfeited'; amount: bigint }
    | { eventName: 'PoolReset'; generation: bigint }
  )

export interface ScheduleExecutedRecord extends ScheduleRecord {
  eventName: 'ScheduleExecuted'
  tx?: Hex
}

export interface ActivationEvent extends ChainPosition {
  eventName: 'Activated'
  holding: Address
  jobId: bigint
  worker: Address
  agentId: bigint
  feeBps: bigint | number
  fee: bigint
  net: bigint
  workerBond?: bigint
  tx: Hex
}

export interface TopUpRecord extends ChainPosition {
  eventName: 'ToppedUp'
  holding: Address
  jobId: bigint
  contributor: Address
  amount: bigint
  bonus: bigint
  tx?: Hex
}

export interface MetadataSetRecord extends ChainPosition {
  eventName: 'MetadataSet'
  agentId: bigint
  key: string
  value: Hex
  tx?: Hex
}

export interface FundingRecord extends ChainPosition {
  eventName: 'EpochFunded'
  epoch: bigint
  amount: bigint
  totalFunded?: bigint
  tx?: Hex
}

export interface RewardSettledRecord extends ChainPosition {
  eventName: 'RewardSettled'
  holding: Address
  jobId: bigint
  to: Address
  outcome: number
  amount: bigint
  tx: Hex
}

export type LedgerRecord =
  | VaultRecord
  | ScheduleExecutedRecord
  | ActivationEvent
  | TopUpRecord
  | MetadataSetRecord
  | FundingRecord
  | RewardSettledRecord

const keyOf = (account: Address, delegator: Address) => `${account.toLowerCase()}:${delegator.toLowerCase()}`
const jobKey = (holding: Address, jobId: bigint) => `${holding.toLowerCase()}:${jobId}`
// SAFETY: Lowercasing a typed address preserves its validated hex address shape.
const lower = (account: Address) => account.toLowerCase() as Address

function addPosition(ledger: MiningLedger, account: Address, delegator: Address): PositionState {
  const generation = ledger.poolOf(account).generation
  const key = keyOf(account, delegator)
  const previous = ledger.positions.get(key)
  if (previous?.generation === generation) return previous
  const position = { account: lower(account), delegator: lower(delegator), shares: 0n, queued: 0n, generation }
  ledger.positions.set(key, position)
  return position
}

function applyVault(ledger: MiningLedger, record: VaultRecord): void {
  const pool = ledger.poolOf(record.account)
  if (record.eventName === 'PoolReset') {
    const generation = record.generation
    if (pool.assets !== 0n || generation !== pool.generation + 1n) throw new Error('incomplete vault reset history')
    pool.shares = 0n
    pool.queued = 0n
    pool.generation = generation
    return
  }
  if (record.eventName === 'Slashed' || record.eventName === 'Forfeited') {
    if (record.amount <= 0n || record.amount > pool.assets) throw new Error('incomplete vault asset history')
    pool.assets -= record.amount
    return
  }
  const position = addPosition(ledger, record.account, record.delegator)
  applyPositionEvent(pool, position, record)
  if (pool.assets < 0n || pool.shares < 0n || pool.queued < 0n || pool.queued > pool.shares)
    throw new Error('incomplete vault pool history')
  if (position.shares < 0n || position.queued < 0n || position.queued > position.shares)
    throw new Error('incomplete vault position history')
}

function applyPositionEvent(
  pool: PoolState,
  position: PositionState,
  record: Extract<VaultRecord, { delegator: Address }>,
): void {
  const { assets, shares } = record
  if (shares <= 0n || assets < 0n) throw new Error('invalid vault event amounts')
  switch (record.eventName) {
    case 'Delegated': {
      if (assets === 0n || (pool.assets === 0n && pool.shares !== 0n))
        throw new Error('incomplete vault deposit history')
      pool.assets += assets
      pool.shares += shares
      position.shares += shares
      break
    }
    case 'UndelegateRequested': {
      if (record.queuedShares !== position.queued + shares) throw new Error('incomplete vault queue history')
      pool.queued += shares
      position.queued = record.queuedShares
      break
    }
    case 'UndelegateCancelled': {
      if (shares !== position.queued) throw new Error('incomplete vault cancellation history')
      pool.queued -= shares
      position.queued = 0n
      break
    }
    case 'Withdrawn': {
      if (shares !== position.queued) throw new Error('incomplete vault withdrawal history')
      pool.assets -= assets
      pool.shares -= shares
      pool.queued -= shares
      position.shares -= shares
      position.queued = 0n
      break
    }
  }
}

/** Pure ordered replay for mining v2. It intentionally contains no RPC or contract reads. */
export class MiningLedger {
  readonly pools = new Map<Address, PoolState>()
  readonly positions = new Map<string, PositionState>()
  readonly feeSchedules: ScheduleExecutedRecord[] = []
  readonly activations = new Map<string, ActivationRecord & { rank: number; workerBond: bigint }>()
  readonly topUps: TopUpRecord[] = []
  readonly wallets = new Map<Address, Set<bigint>>()
  readonly shareSets = new Map<bigint, MetadataSetRecord[]>()
  readonly funding: FundingRecord[] = []
  /** RewardSettled is emitted before FeeCharged in a settlement transaction. */
  readonly settledJobs = new Set<string>()
  lastPosition: ChainPosition | null = null

  poolOf(account: Address): PoolState {
    const existing = this.pools.get(lower(account))
    if (existing !== undefined) return existing
    const pool = { assets: 0n, shares: 0n, queued: 0n, generation: 0n }
    this.pools.set(lower(account), pool)
    return pool
  }

  stakeOf(account: Address): bigint {
    const pool = this.poolOf(account)
    return pool.shares === 0n ? 0n : ((pool.shares - pool.queued) * pool.assets) / pool.shares
  }

  positionOf(account: Address, delegator: Address): PositionState {
    const pool = this.poolOf(account)
    const position = this.positions.get(keyOf(account, delegator))
    if (position?.generation !== pool.generation)
      return { account, delegator, shares: 0n, queued: 0n, generation: pool.generation }
    return position ?? { account, delegator, shares: 0n, queued: 0n, generation: pool.generation }
  }

  activeShares(account: Address, delegator: Address): bigint {
    const position = this.positionOf(account, delegator)
    return position.shares - position.queued
  }

  apply(record: LedgerRecord): void {
    if (this.lastPosition !== null && chainOrder(this.lastPosition, record) >= 0)
      throw new Error('ledger records are out of chain order or duplicated')
    if (record.eventName === 'ScheduleExecuted') {
      validateScheduleV2(record)
      const schedule = { ...record }
      this.feeSchedules.push(schedule)
    } else if (record.eventName === 'Activated') {
      this.applyActivation(record)
    } else if (record.eventName === 'ToppedUp') {
      this.topUps.push(record)
    } else if (record.eventName === 'MetadataSet') {
      if (record.key === 'sidequest.backerShareBps') {
        const sets = this.shareSets.get(record.agentId) ?? []
        sets.push(record)
        this.shareSets.set(record.agentId, sets)
      }
    } else if (record.eventName === 'EpochFunded') {
      this.funding.push(record)
    } else if (record.eventName === 'RewardSettled') {
      this.settledJobs.add(jobKey(record.holding, record.jobId))
    } else {
      applyVault(this, record)
    }
    this.lastPosition = { block: record.block, logIndex: record.logIndex }
  }

  private applyActivation(record: ActivationEvent): void {
    const schedule = scheduleAt(this.feeSchedules, record)
    const feeBps = BigInt(record.feeBps)
    const rank = rankOfFeeBps(feeBps, schedule)
    const heldRank = rankOfStake(this.stakeOf(record.worker), schedule)
    if (rank !== heldRank) throw new Error('vault replay disagrees with activation snapshot')
    const activation = {
      block: record.block,
      logIndex: record.logIndex,
      tx: record.tx,
      holding: lower(record.holding),
      jobId: record.jobId,
      worker: lower(record.worker),
      agentId: record.agentId,
      feeBps,
      fee: record.fee,
      net: record.net,
      workerBond: record.workerBond ?? 0n,
      rank,
    }
    this.activations.set(jobKey(record.holding, record.jobId), activation)
    const wallet = lower(record.worker)
    const ids = this.wallets.get(wallet) ?? new Set<bigint>()
    ids.add(record.agentId)
    this.wallets.set(wallet, ids)
  }

  snapshot() {
    return {
      pools: new Map([...this.pools].map(([account, pool]) => [account, { ...pool }])),
      stakes: new Map([...this.pools.keys()].map((account) => [account, this.stakeOf(account)])),
      positions: new Map(
        [...this.positions].map(([key, position]) => {
          const current = this.positionOf(position.account, position.delegator)
          return [key, { ...current, active: current.shares - current.queued }]
        }),
      ),
      feeSchedules: this.feeSchedules.toSorted(chainOrder),
      activations: new Map(this.activations),
      topUps: this.topUps.toSorted(chainOrder),
      wallets: new Map([...this.wallets].map(([wallet, ids]) => [wallet, new Set(ids)])),
      shareSets: new Map([...this.shareSets].map(([agentId, sets]) => [agentId, sets.toSorted(chainOrder)])),
      funding: this.funding.toSorted(chainOrder),
      settledJobs: new Set(this.settledJobs),
      lastPosition: this.lastPosition === null ? null : { ...this.lastPosition },
    }
  }

  /** Restore a checkpoint without replaying the deployment history. */
  static fromSnapshot(snapshot: ReturnType<MiningLedger['snapshot']>): MiningLedger {
    const ledger = new MiningLedger()
    for (const [account, pool] of snapshot.pools) ledger.pools.set(account, { ...pool })
    for (const [key, position] of snapshot.positions) {
      ledger.positions.set(key, {
        account: position.account,
        delegator: position.delegator,
        shares: position.shares,
        queued: position.queued,
        generation: position.generation,
      })
    }
    ledger.feeSchedules.push(...snapshot.feeSchedules)
    for (const [key, activation] of snapshot.activations) ledger.activations.set(key, { ...activation })
    ledger.topUps.push(...snapshot.topUps)
    for (const [wallet, ids] of snapshot.wallets) ledger.wallets.set(wallet, new Set(ids))
    for (const [agentId, sets] of snapshot.shareSets) ledger.shareSets.set(agentId, [...sets])
    ledger.funding.push(...snapshot.funding)
    for (const key of snapshot.settledJobs) ledger.settledJobs.add(key)
    ledger.lastPosition = snapshot.lastPosition === null ? null : { ...snapshot.lastPosition }
    return ledger
  }

  activationOf(holding: Address, jobId: bigint) {
    const activation = this.activations.get(jobKey(holding, jobId))
    if (activation === undefined) throw new Error('missing activation history')
    return activation
  }

  bonusBefore(fee: FeeCharged): bigint {
    return (
      this.topUps
        .filter(
          (record) =>
            jobKey(record.holding, record.jobId) === jobKey(fee.holding, fee.jobId) && chainOrder(record, fee) < 0,
        )
        .at(-1)?.bonus ?? 0n
    )
  }
}

export function replayLedger(records: readonly LedgerRecord[]): MiningLedger {
  const ledger = new MiningLedger()
  for (const record of records.toSorted(chainOrder)) ledger.apply(record)
  return ledger
}
