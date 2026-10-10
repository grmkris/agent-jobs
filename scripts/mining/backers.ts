import { decodeAbiParameters, type Address, type Hex } from './viem.ts'
import type { FeeCharged, LogPosition } from './compute.ts'

export const BACKER_SHARE_KEY = 'sidequest.backerShareBps'
export interface BackerPosition {
  account: Address
  delegator: Address
  start: bigint
  end: bigint
  weight: bigint
}

export interface MetadataSetRecord extends LogPosition {
  agentId: bigint
  key: string
  value: Hex
}

export interface WorkerAgentRecord extends LogPosition {
  jobId: bigint
  worker: Address
  agentId: bigint
}

export interface BackerWorker {
  worker: Address
  agentId: bigint
  bps: bigint
  set: MetadataSetRecord | null
  positions: BackerPosition[]
}

const order = (a: { block: bigint; logIndex: number }, b: { block: bigint; logIndex: number }) =>
  a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1
const workerOrder = (a: BackerWorker, b: BackerWorker) => (a.worker < b.worker ? -1 : a.worker > b.worker ? 1 : 0)
/** ABI encoding of uint16 is exactly one 32-byte word. Invalid values are opt-out (zero). */
export function decodeBackerShareBps(value: Hex): bigint {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) return 0n
  const decoded = decodeAbiParameters([{ type: 'uint256' }], value)[0]
  return decoded > 10_000n ? 10_000n : decoded
}

export type VaultEventRecord = { block: bigint; logIndex: number; account: Address } & (
  | { eventName: 'Delegated' | 'Withdrawn'; delegator: Address; shares: bigint }
  | { eventName: 'UndelegateRequested'; delegator: Address; queuedShares: bigint }
  | { eventName: 'UndelegateCancelled'; delegator: Address }
  | { eventName: 'PoolReset'; generation: bigint }
  | { eventName: 'Slashed' }
  | { eventName: 'Forfeited' }
)

interface Position {
  account: Address
  delegator: Address
  shares: bigint
  queued: bigint
  generation: bigint
}
interface Ledger {
  positions: Map<string, Position>
  generations: Map<Address, bigint>
}
const positionKey = (account: Address, delegator: Address) => `${account}:${delegator}`

/** Port of StakeVaultLedger.t.sol: exits affect shares, asset-only losses do not. */
function replayEvent(ledger: Ledger, log: VaultEventRecord): void {
  const generation = ledger.generations.get(log.account) ?? 0n
  if (log.eventName === 'Slashed' || log.eventName === 'Forfeited') return
  if (log.eventName === 'PoolReset') {
    if (log.generation !== generation + 1n) throw new Error('incomplete vault reset history')
    ledger.generations.set(log.account, log.generation)
    return
  }
  const key = positionKey(log.account, log.delegator)
  const existing = ledger.positions.get(key)
  const position =
    existing?.generation === generation
      ? existing
      : { account: log.account, delegator: log.delegator, shares: 0n, queued: 0n, generation }
  switch (log.eventName) {
    case 'Delegated':
      position.shares += log.shares
      break
    case 'UndelegateRequested':
      position.queued = log.queuedShares
      break
    case 'UndelegateCancelled':
      position.queued = 0n
      break
    case 'Withdrawn':
      position.shares -= log.shares
      position.queued = 0n
      break
  }
  if (position.shares < 0n || position.queued < 0n || position.queued > position.shares)
    throw new Error('incomplete vault position history')
  ledger.positions.set(key, position)
}

function snapshot(
  ledger: Ledger,
): Map<string, { active: bigint; generation: bigint; account: Address; delegator: Address }> {
  return new Map(
    [...ledger.positions].map(([key, position]) => {
      const generation = ledger.generations.get(position.account) ?? 0n
      const active = position.generation === generation ? position.shares - position.queued : 0n
      return [key, { active, generation, account: position.account, delegator: position.delegator }]
    }),
  )
}

export const positionOrder = (a: BackerPosition, b: BackerPosition) =>
  a.account === b.account
    ? a.delegator < b.delegator
      ? -1
      : a.delegator > b.delegator
        ? 1
        : 0
    : a.account < b.account
      ? -1
      : 1

/** State after fromBlock - 1 and after toBlock; new generations have no eligible start shares. */
export function replayVaultEvents(
  logs: readonly VaultEventRecord[],
  fromBlock: bigint,
  toBlock: bigint,
): BackerPosition[] {
  const ledger: Ledger = { positions: new Map(), generations: new Map() }
  const ordered = logs.filter((log) => log.block <= toBlock).toSorted(order)
  for (const log of ordered.filter((record) => record.block < fromBlock)) replayEvent(ledger, log)
  const start = snapshot(ledger)
  for (const log of ordered.filter((record) => record.block >= fromBlock)) replayEvent(ledger, log)
  const end = snapshot(ledger)
  return [...end]
    .map(([key, position]) => {
      const previous = start.get(key)
      const startShares = previous?.generation === position.generation ? previous.active : 0n
      const endShares = position.active
      return {
        account: position.account,
        delegator: position.delegator,
        start: startShares,
        end: endShares,
        weight: startShares < endShares ? startShares : endShares,
      }
    })
    .toSorted(positionOrder)
}

function agentOfFee(fee: FeeCharged, activations: readonly WorkerAgentRecord[]): bigint {
  const activation = activations
    .filter((a) => a.holding === fee.holding && a.jobId === fee.jobId && a.worker === fee.worker && order(a, fee) < 0)
    .toSorted(order)
    .at(-1)
  return activation?.agentId ?? 0n
}

/** A worker allocation has one share. Missing or conflicting paid-job identities opt out. */
export function resolveBackerWorkers(input: {
  fees: readonly FeeCharged[]
  activations: readonly WorkerAgentRecord[]
  metadata: readonly MetadataSetRecord[]
  positions: readonly BackerPosition[]
  fromBlock: bigint
}): BackerWorker[] {
  const byWorker = new Map<Address, Set<bigint>>()
  for (const fee of input.fees) {
    const ids = byWorker.get(fee.worker) ?? new Set<bigint>()
    ids.add(agentOfFee(fee, input.activations))
    byWorker.set(fee.worker, ids)
  }
  const metadata = input.metadata.filter((m) => m.key === BACKER_SHARE_KEY && m.block < input.fromBlock).toSorted(order)
  return [...byWorker]
    .map(([worker, ids]) => {
      const agentId = ids.size === 1 ? ([...ids][0] ?? 0n) : 0n
      const set = agentId === 0n ? null : (metadata.filter((m) => m.agentId === agentId).at(-1) ?? null)
      const bps = set === null ? 0n : decodeBackerShareBps(set.value)
      const positions = input.positions.filter((p) => p.account === worker).toSorted(positionOrder)
      return { worker, agentId, bps, set, positions }
    })
    .toSorted(workerOrder)
}

/** Omit both additions for opt-out epochs, preserving the canonical JSON and its existing dataHash. */
export function backerInputs(workers: readonly BackerWorker[]) {
  if (!workers.some((worker) => worker.bps > 0n)) return undefined
  return {
    backerShares: workers.toSorted(workerOrder).map((worker) => ({
      agentId: worker.agentId.toString(),
      worker: worker.worker,
      bps: worker.bps.toString(),
      set:
        worker.set === null
          ? null
          : { block: worker.set.block.toString(), logIndex: worker.set.logIndex, tx: worker.set.tx.toLowerCase() },
    })),
    backerPositions: workers
      .filter((worker) => worker.bps > 0n)
      .flatMap((worker) => worker.positions)
      .toSorted(positionOrder)
      .map((position) => ({
        account: position.account,
        delegator: position.delegator,
        start: position.start.toString(),
        end: position.end.toString(),
        weight: position.weight.toString(),
      })),
  }
}
