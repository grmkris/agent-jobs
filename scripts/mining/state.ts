import { Schema } from 'effect'
import { dataHashOf } from './compute.ts'
import { chainOrder, rankOfFeeBps, scheduleAt, validateScheduleV2 } from './credit.ts'
import { MiningLedger } from './ledger.ts'
import { lower } from './ledger-chain.ts'
import { getAddress, type Address, type Hex } from './viem.ts'

const uintSchema = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/))
const addressSchema = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{40}$/))
const hashSchema = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/))
const hexSchema = Schema.String.check(Schema.isPattern(/^0x(?:[0-9a-f]{2})*$/))
const at = { block: uintSchema, logIndex: uintSchema, tx: hashSchema }
const scheduleSchema = Schema.Struct({
  ...at,
  thresholds: Schema.Array(uintSchema),
  bps: Schema.Array(uintSchema),
  treasury: addressSchema,
})
const activationSchema = Schema.Struct({
  holding: addressSchema,
  jobId: uintSchema,
  ...at,
  worker: addressSchema,
  agentId: uintSchema,
  feeBps: uintSchema,
  fee: uintSchema,
  net: uintSchema,
  workerBond: uintSchema,
  rank: uintSchema,
})
const topUpSchema = Schema.Struct({
  holding: addressSchema,
  jobId: uintSchema,
  ...at,
  contributor: addressSchema,
  amount: uintSchema,
  bonus: uintSchema,
})
const poolSchema = Schema.Struct({
  account: addressSchema,
  assets: uintSchema,
  shares: uintSchema,
  queuedShares: uintSchema,
  generation: uintSchema,
})
const positionSchema = Schema.Struct({
  account: addressSchema,
  delegator: addressSchema,
  shares: uintSchema,
  queued: uintSchema,
  generation: uintSchema,
})
const shareSchema = Schema.Struct({ agentId: uintSchema, ...at, value: hexSchema })
const contractsSchema = Schema.Struct({
  holdings: Schema.Array(addressSchema),
  vault: addressSchema,
  identity: addressSchema,
  feeSchedule: addressSchema,
  reserve: addressSchema,
  distributor: addressSchema,
})
const stateSchema = Schema.Struct({
  format: Schema.Literal('sidequest-mining-state'),
  version: Schema.Literal(1),
  chainId: uintSchema,
  epoch: uintSchema,
  block: uintSchema,
  blockHash: hashSchema,
  genesisBlock: uintSchema,
  contracts: contractsSchema,
  feeSchedule: Schema.Struct({ history: Schema.Array(scheduleSchema) }),
  vault: Schema.Struct({ pools: Schema.Array(poolSchema), positions: Schema.Array(positionSchema) }),
  activations: Schema.Array(activationSchema),
  topUps: Schema.Array(topUpSchema),
  wallets: Schema.Array(Schema.Struct({ wallet: addressSchema, agentIds: Schema.Array(uintSchema) })),
  shares: Schema.Struct({ pruneBlock: uintSchema, sets: Schema.Array(shareSchema) }),
  budget: Schema.Struct({
    funding: Schema.Array(Schema.Struct({ epoch: uintSchema, amount: uintSchema })),
    total: uintSchema,
  }),
})
export type MiningState = typeof stateSchema.Type
export type StateContracts = typeof contractsSchema.Type
export interface StateContext {
  chainId: number
  epoch: bigint
  block: bigint
  blockHash: Hex
  genesisBlock: bigint
  contracts: {
    holdings: readonly Address[]
    vault: Address
    identity: Address
    feeSchedule: Address
    reserve: Address
    distributor: Address
  }
  pruneBlock: bigint
}
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const numericOrder = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0)
const hex = (value: string): Hex => {
  const decoded = Schema.decodeUnknownSync(hexSchema)(value)
  // SAFETY: The schema accepts only even-length lowercase hex.
  return decoded as Hex
}
const event = (value: { block: bigint; logIndex: number; tx?: Hex }) => {
  if (value.tx === undefined) throw new Error('state history is missing a transaction')
  return { block: String(value.block), logIndex: String(value.logIndex), tx: hex(value.tx.toLowerCase()) }
}
const jobKey = (value: { holding: string; jobId: bigint | string }) => `${value.holding.toLowerCase()}:${value.jobId}`

export function stateContractsOf(contracts: StateContext['contracts']): StateContracts {
  return {
    holdings: contracts.holdings.map(lower).toSorted(),
    vault: lower(contracts.vault),
    identity: lower(contracts.identity),
    feeSchedule: lower(contracts.feeSchedule),
    reserve: lower(contracts.reserve),
    distributor: lower(contracts.distributor),
  }
}

function retainedShares(ledger: MiningLedger, pruneBlock: bigint) {
  return [...ledger.shareSets]
    .toSorted(([a], [b]) => numericOrder(a, b))
    .flatMap(([agentId, sets]) => {
      const ordered = sets.toSorted(chainOrder)
      const last = ordered.filter((set) => set.block < pruneBlock).at(-1)
      const retained = [...(last === undefined ? [] : [last]), ...ordered.filter((set) => set.block >= pruneBlock)]
      return retained.map((set) => ({ agentId: String(agentId), ...event(set), value: hex(set.value.toLowerCase()) }))
    })
}

function stateVault(ledger: MiningLedger) {
  const pools = [...ledger.pools]
    .filter(([, p]) => p.assets !== 0n || p.shares !== 0n || p.queued !== 0n || p.generation !== 0n)
    .toSorted(([a], [b]) => order(a, b))
    .map(([account, pool]) => ({
      account: lower(account),
      assets: String(pool.assets),
      shares: String(pool.shares),
      queuedShares: String(pool.queued),
      generation: String(pool.generation),
    }))
  const positions = [...ledger.positions.values()]
    .filter((p) => p.shares > 0n && p.generation === ledger.poolOf(p.account).generation)
    .toSorted((a, b) => order(a.account, b.account) || order(a.delegator, b.delegator))
    .map((p) => ({
      account: lower(p.account),
      delegator: lower(p.delegator),
      shares: String(p.shares),
      queued: String(p.queued),
      generation: String(p.generation),
    }))
  return { pools, positions }
}

/** Prune only the serialized state; fees and integrity checks still need settled activations in memory. */
export function stateOf(ledger: MiningLedger, context: StateContext): MiningState {
  const activations = [...ledger.activations.values()]
    .filter((a) => !ledger.settledJobs.has(jobKey(a)))
    .toSorted((a, b) => order(a.holding, b.holding) || numericOrder(a.jobId, b.jobId))
    .map((a) => ({
      holding: lower(a.holding),
      jobId: String(a.jobId),
      ...event(a),
      worker: lower(a.worker),
      agentId: String(a.agentId),
      feeBps: String(a.feeBps),
      fee: String(a.fee),
      net: String(a.net),
      workerBond: String(a.workerBond),
      rank: String(a.rank),
    }))
  const jobs = new Set(activations.map(jobKey))
  const funding = new Map<bigint, bigint>()
  for (const record of ledger.funding) funding.set(record.epoch, (funding.get(record.epoch) ?? 0n) + record.amount)
  return {
    format: 'sidequest-mining-state',
    version: 1,
    chainId: String(context.chainId),
    epoch: String(context.epoch),
    block: String(context.block),
    blockHash: hex(context.blockHash.toLowerCase()),
    genesisBlock: String(context.genesisBlock),
    contracts: stateContractsOf(context.contracts),
    feeSchedule: {
      history: ledger.feeSchedules.toSorted(chainOrder).map((set) => ({
        ...event(set),
        thresholds: set.thresholds.map(String),
        bps: set.bps.map(String),
        treasury: lower(set.treasury),
      })),
    },
    vault: stateVault(ledger),
    activations,
    topUps: ledger.topUps
      .filter((t) => jobs.has(jobKey(t)))
      .toSorted(chainOrder)
      .map((t) => ({
        holding: lower(t.holding),
        jobId: String(t.jobId),
        ...event(t),
        contributor: lower(t.contributor),
        amount: String(t.amount),
        bonus: String(t.bonus),
      })),
    wallets: [...ledger.wallets]
      .toSorted(([a], [b]) => order(a, b))
      .map(([wallet, ids]) => ({
        wallet: lower(wallet),
        agentIds: [...ids].toSorted(numericOrder).map(String),
      })),
    shares: { pruneBlock: String(context.pruneBlock), sets: retainedShares(ledger, context.pruneBlock) },
    budget: {
      funding: [...funding]
        .toSorted(([a], [b]) => numericOrder(a, b))
        .map(([epoch, amount]) => ({ epoch: String(epoch), amount: String(amount) })),
      total: String([...funding.values()].reduce((sum, amount) => sum + amount, 0n)),
    },
  }
}
export const stateHashOf = (state: MiningState): Hex => dataHashOf(state)
const address = (value: string) => lower(getAddress(value))
const position = (value: { block: string; logIndex: string; tx: string }) => {
  const logIndex = Number(value.logIndex)
  if (!Number.isSafeInteger(logIndex)) throw new Error('state log index is not safe')
  return { block: BigInt(value.block), logIndex, tx: hex(value.tx) }
}

function restoreVault(state: MiningState, ledger: MiningLedger) {
  for (const p of state.vault.pools)
    ledger.pools.set(address(p.account), {
      assets: BigInt(p.assets),
      shares: BigInt(p.shares),
      queued: BigInt(p.queuedShares),
      generation: BigInt(p.generation),
    })
  for (const p of state.vault.positions)
    ledger.positions.set(`${p.account}:${p.delegator}`, {
      account: address(p.account),
      delegator: address(p.delegator),
      shares: BigInt(p.shares),
      queued: BigInt(p.queued),
      generation: BigInt(p.generation),
    })
  for (const [account, pool] of ledger.pools) {
    const positions = [...ledger.positions.values()].filter((p) => p.account === account)
    if (
      positions.some((p) => p.generation !== pool.generation || p.queued > p.shares || p.shares === 0n) ||
      positions.reduce((sum, p) => sum + p.shares, 0n) !== pool.shares ||
      positions.reduce((sum, p) => sum + p.queued, 0n) !== pool.queued
    )
      throw new Error('state vault totals disagree')
  }
}

/** Boundary-decoded checkpoints have no retired positions or settled jobs. */
export function ledgerFromState(state: MiningState): MiningLedger {
  const ledger = new MiningLedger()
  restoreVault(state, ledger)
  for (const set of state.feeSchedule.history) {
    const schedule = {
      ...position(set),
      thresholds: set.thresholds.map(BigInt),
      bps: set.bps.map(BigInt),
      treasury: address(set.treasury),
      eventName: 'ScheduleExecuted' as const,
    }
    validateScheduleV2(schedule)
    ledger.feeSchedules.push(schedule)
  }
  for (const a of state.activations) {
    const activation = {
      ...position(a),
      holding: address(a.holding),
      jobId: BigInt(a.jobId),
      worker: address(a.worker),
      agentId: BigInt(a.agentId),
      feeBps: BigInt(a.feeBps),
      fee: BigInt(a.fee),
      net: BigInt(a.net),
      workerBond: BigInt(a.workerBond),
      rank: Number(a.rank),
    }
    if (activation.rank !== rankOfFeeBps(activation.feeBps, scheduleAt(ledger.feeSchedules, activation)))
      throw new Error('state activation rank mismatch')
    ledger.activations.set(jobKey(activation), activation)
  }
  for (const t of state.topUps)
    ledger.topUps.push({
      ...position(t),
      holding: address(t.holding),
      jobId: BigInt(t.jobId),
      contributor: address(t.contributor),
      amount: BigInt(t.amount),
      bonus: BigInt(t.bonus),
      eventName: 'ToppedUp',
    })
  for (const wallet of state.wallets) ledger.wallets.set(address(wallet.wallet), new Set(wallet.agentIds.map(BigInt)))
  for (const set of state.shares.sets) {
    const agentId = BigInt(set.agentId),
      sets = ledger.shareSets.get(agentId) ?? []
    sets.push({
      ...position(set),
      agentId,
      key: 'sidequest.backerShareBps',
      value: hex(set.value),
      eventName: 'MetadataSet',
    })
    ledger.shareSets.set(agentId, sets)
  }
  for (const f of state.budget.funding)
    ledger.funding.push({
      eventName: 'EpochFunded',
      block: BigInt(state.block),
      logIndex: 0,
      epoch: BigInt(f.epoch),
      amount: BigInt(f.amount),
    })
  if (ledger.funding.reduce((sum, f) => sum + f.amount, 0n) !== BigInt(state.budget.total))
    throw new Error('state funding total mismatch')
  ledger.lastPosition = { block: BigInt(state.block), logIndex: Number.MAX_SAFE_INTEGER }
  return ledger
}

export function parseState(value: unknown): MiningState {
  const state = Schema.decodeUnknownSync(stateSchema)(value)
  const ledger = ledgerFromState(state)
  const canonical = stateOf(ledger, {
    chainId: Number(state.chainId),
    epoch: BigInt(state.epoch),
    block: BigInt(state.block),
    blockHash: hex(state.blockHash),
    genesisBlock: BigInt(state.genesisBlock),
    pruneBlock: BigInt(state.shares.pruneBlock),
    contracts: {
      holdings: state.contracts.holdings.map(address),
      vault: address(state.contracts.vault),
      identity: address(state.contracts.identity),
      feeSchedule: address(state.contracts.feeSchedule),
      reserve: address(state.contracts.reserve),
      distributor: address(state.contracts.distributor),
    },
  })
  if (JSON.stringify(value) !== JSON.stringify(canonical)) throw new Error('state is not canonical')
  if (BigInt(state.genesisBlock) > BigInt(state.block)) throw new Error('state precedes genesis')
  return state
}
