/** Delegation discovery over the unchanged D1 ledger, guarded by a fresh canonical checkpoint. */
import { BoardError, delegationPositions, type PositionFilters, type DelegationSnapshot } from '@agent-jobs/board'
import { indexedDelegations, type AsyncSql } from '@agent-jobs/indexer'
import * as sdk from '@agent-jobs/sdk'
import type { Address } from 'viem'
import { COLLECT_INDEX_MAX_AGE } from './collect-index.ts'

export async function stakingSnapshot(sql: AsyncSql, ctx: sdk.Ctx, filters: PositionFilters, now: number): Promise<DelegationSnapshot> {
  const h = ctx.deployment.hireling
  if (h === null || ctx.stack.kind !== 'hireling-v1') throw new BoardError('unavailable', 'delegated backing is unavailable')
  type Checkpoint = { next_block: number; updated_at: number; block_hash: string | null }
  const query = 'SELECT next_block, updated_at, block_hash FROM checkpoint WHERE chain_id=?'
  const [cp] = await sql.all<Checkpoint>(query, ctx.deployment.chainId)
  if (cp === undefined || cp.block_hash === null || cp.next_block <= Number(h.block) || now - cp.updated_at > COLLECT_INDEX_MAX_AGE || cp.updated_at > now + 5) {
    throw new BoardError('chain', 'the delegation index is unavailable or behind')
  }
  const blockNumber = BigInt(cp.next_block - 1)
  const [indexed, finalized] = await Promise.all([
    ctx.publicClient.getBlock({ blockNumber }),
    ctx.publicClient.getBlock({ blockTag: 'finalized' }),
  ])
  if (indexed.hash?.toLowerCase() !== cp.block_hash.toLowerCase() || Number(finalized.timestamp - indexed.timestamp) > COLLECT_INDEX_MAX_AGE) {
    throw new BoardError('chain', 'the delegation index is behind or divergent')
  }
  const candidates = await indexedDelegations(sql, ctx.deployment.chainId, h.vault, { ...filters, toBlock: cp.next_block })
  const [after] = await sql.all<Checkpoint>(query, ctx.deployment.chainId)
  if (after === undefined || after.next_block !== cp.next_block || after.updated_at !== cp.updated_at || after.block_hash !== cp.block_hash) {
    throw new BoardError('chain', 'the delegation index changed during discovery; retry shortly')
  }
  return { blockNumber, candidates }
}

export async function backingCard(sql: AsyncSql, ctx: sdk.Ctx, account: Address, wallet: Address | undefined, now: number) {
  const snapshot = await stakingSnapshot(sql, ctx, { account }, now)
  const knownGeneration = wallet === undefined ? undefined : snapshot.candidates.find(c => c.delegator.toLowerCase() === wallet.toLowerCase())?.generation
  const [backing, discovered, position] = await Promise.all([
    sdk.getBacking(ctx, account, { blockNumber: snapshot.blockNumber }),
    delegationPositions(ctx, snapshot),
    wallet === undefined ? null : sdk.getPosition(ctx, account, wallet, { blockNumber: snapshot.blockNumber,
      ...(knownGeneration === undefined ? {} : { knownGeneration }) }),
  ])
  const active = discovered.positions.filter(p => p.shares > 0n)
  active.sort((a, b) => a.value === b.value ? a.delegator.localeCompare(b.delegator) : a.value > b.value ? -1 : 1)
  return { ...backing, token: discovered.token, vault: discovered.vault, source: discovered.source,
    delegatorCount: active.length, topDelegators: active.slice(0, 10), position }
}
