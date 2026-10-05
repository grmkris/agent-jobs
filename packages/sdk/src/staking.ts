/** Delegated backing and wallet-owned positions, read at one block. Amounts are FACTORY base units. */
import { type Address, getAbiItem } from 'viem'
import { feeScheduleAbi, stakeVaultAbi } from './abi/index.ts'
import type { Ctx } from './actions.ts'
import { delegationCandidates, type StakeLedgerEvent } from './staking-ledger.ts'

export interface StakePool {
  readonly assets: bigint
  readonly reserved: bigint
  readonly shares: bigint
  readonly queuedShares: bigint
  readonly generation: bigint
}

export interface StakePosition {
  readonly shares: bigint
  readonly queuedShares: bigint
  readonly unlockAt: number
  readonly generation: bigint
}

export interface StakeReadOptions {
  readonly blockNumber?: bigint
  /** Last observed position generation from the event ledger. positionOf normalizes retired positions to zero. */
  readonly knownGeneration?: bigint
}

export function shareValue(pool: StakePool, shares: bigint): bigint {
  return pool.shares === 0n ? 0n : shares * pool.assets / pool.shares
}

export function backingOf(pool: StakePool, schedule: { readonly thresholds: readonly bigint[]; readonly bps: readonly number[] }) {
  const active = shareValue(pool, pool.shares - pool.queuedShares)
  const queued = shareValue(pool, pool.queuedShares)
  let index = 0
  for (const [i, threshold] of schedule.thresholds.entries()) if (active >= threshold) index = i
  const nextThreshold = schedule.thresholds[index + 1] ?? null
  return {
    ...pool,
    active,
    queued,
    available: active > pool.reserved ? active - pool.reserved : 0n,
    tier: {
      index,
      threshold: schedule.thresholds[index]!,
      feeBps: schedule.bps[index]!,
      nextThreshold,
      nextFeeBps: schedule.bps[index + 1] ?? null,
      needed: nextThreshold === null ? 0n : nextThreshold - active,
    },
  }
}

export function positionIn(pool: StakePool, position: StakePosition, knownGeneration?: bigint) {
  const retired = position.generation !== pool.generation
  const shares = retired ? 0n : position.shares
  const queuedShares = retired ? 0n : position.queuedShares
  const activeShares = shares - queuedShares
  return {
    shares,
    activeShares,
    queuedShares,
    value: shareValue(pool, shares),
    activeValue: shareValue(pool, activeShares),
    queued: shareValue(pool, queuedShares),
    unlockAt: queuedShares === 0n ? 0 : position.unlockAt,
    generation: pool.generation,
    // The normalized zero view cannot distinguish an absent position from a retired generation on its own.
    staleGeneration: retired ? true : shares > 0n ? false : knownGeneration === undefined ? null : knownGeneration !== pool.generation,
    shareBps: pool.shares === 0n ? 0 : Number(shares * 10_000n / pool.shares),
  }
}

function vaultOf(ctx: Ctx) {
  if (ctx.stack.kind !== 'hireling-v1' || ctx.deployment.hireling === null) throw new Error('Delegated staking requires Hireling v1')
  return ctx.deployment.hireling
}

export async function getBacking(ctx: Ctx, account: Address, options: StakeReadOptions = {}) {
  const h = vaultOf(ctx)
  const blockNumber = options.blockNumber ?? await ctx.publicClient.getBlockNumber()
  const [pool, schedule] = await Promise.all([
    ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'poolOf', args: [account], blockNumber }),
    ctx.publicClient.readContract({ address: h.feeSchedule, abi: feeScheduleAbi, functionName: 'schedule', blockNumber }),
  ])
  return { account, blockNumber, ...backingOf(pool, schedule) }
}

export async function getPosition(ctx: Ctx, account: Address, delegator: Address, options: StakeReadOptions = {}) {
  const h = vaultOf(ctx)
  const blockNumber = options.blockNumber ?? await ctx.publicClient.getBlockNumber()
  const [pool, position] = await Promise.all([
    ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'poolOf', args: [account], blockNumber }),
    ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'positionOf', args: [account, delegator], blockNumber }),
  ])
  return { account, delegator, blockNumber, ...positionIn(pool, position, options.knownGeneration) }
}

export interface DelegationReadOptions extends StakeReadOptions {
  /** Restrict discovery to a pool. fromBlock overrides the vault creation block for local fixtures. */
  readonly account?: Address
  readonly fromBlock?: bigint
}

/** Event-backed discovery. Values come from the vault at one block; exited/retired positions remain discoverable. */
export async function listDelegations(ctx: Ctx, delegator: Address, options: DelegationReadOptions = {}) {
  const h = vaultOf(ctx)
  const blockNumber = options.blockNumber ?? await ctx.publicClient.getBlockNumber()
  const events = [getAbiItem({ abi: stakeVaultAbi, name: 'Delegated' }), getAbiItem({ abi: stakeVaultAbi, name: 'PoolReset' })] as const
  const ledger: StakeLedgerEvent[] = []
  for (let fromBlock = options.fromBlock ?? h.block; fromBlock <= blockNumber; fromBlock += 10_000n) {
    const end = fromBlock + 9_999n
    const logs = await ctx.publicClient.getLogs({ address: h.vault, events,
      fromBlock, toBlock: end < blockNumber ? end : blockNumber, strict: true })
    for (const log of logs) {
      const entry = { account: log.args.account, blockNumber: log.blockNumber, logIndex: log.logIndex }
      ledger.push(log.eventName === 'PoolReset' ? { ...entry, name: 'PoolReset', generation: log.args.generation }
        : { ...entry, name: 'Delegated', delegator: log.args.delegator })
    }
  }
  const positions = []
  for (const candidate of delegationCandidates(ledger, { delegator, ...(options.account === undefined ? {} : { account: options.account }) })) {
    positions.push(await getPosition(ctx, candidate.account, candidate.delegator, { blockNumber, knownGeneration: candidate.generation }))
  }
  return { source: 'vault-events' as const, blockNumber, delegator, positions }
}
