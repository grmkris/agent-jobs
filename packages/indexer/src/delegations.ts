/** Candidate owners from the existing event ledger. Values are always read from the canonical vault. */
import { getAddress, type Address } from 'viem'
import type { DelegationCandidate } from '@sidequest/sdk'
import type { AsyncSql } from './store.ts'

export interface DelegationFilters {
  readonly wallet?: Address
  readonly account?: Address
  /** Exclusive event boundary, normally the verified index checkpoint. */
  readonly toBlock?: number
}

export async function indexedDelegations(
  sql: AsyncSql,
  chainId: number,
  vault: Address,
  filters: DelegationFilters = {},
): Promise<DelegationCandidate[]> {
  const rows = await sql.all<{ account: string; delegator: string; generation: string }>(
    `WITH deposits AS (
      SELECT lower(json_extract(args_json,'$.account')) AS account,
        lower(json_extract(args_json,'$.delegator')) AS delegator, block, log_index,
        row_number() OVER (PARTITION BY lower(json_extract(args_json,'$.account')), lower(json_extract(args_json,'$.delegator'))
          ORDER BY block DESC, log_index DESC) AS latest
      FROM protocol_events WHERE chain_id=? AND lower(contract)=lower(?) AND name='Delegated' AND block<?
        ${filters.wallet === undefined ? '' : "AND lower(json_extract(args_json,'$.delegator'))=lower(?)"}
        ${filters.account === undefined ? '' : "AND lower(json_extract(args_json,'$.account'))=lower(?)"}
    ) SELECT d.account, d.delegator, coalesce((
      SELECT json_extract(r.args_json,'$.generation') FROM protocol_events r
      WHERE r.chain_id=? AND lower(r.contract)=lower(?) AND r.name='PoolReset'
        AND lower(json_extract(r.args_json,'$.account'))=d.account
        AND (r.block<d.block OR (r.block=d.block AND r.log_index<d.log_index))
      ORDER BY r.block DESC, r.log_index DESC LIMIT 1
    ),'0') AS generation FROM deposits d WHERE d.latest=1 ORDER BY d.account,d.delegator`,
    chainId,
    vault,
    filters.toBlock ?? Number.MAX_SAFE_INTEGER,
    ...(filters.wallet === undefined ? [] : [filters.wallet]),
    ...(filters.account === undefined ? [] : [filters.account]),
    chainId,
    vault,
  )
  return rows.map((row) => ({
    account: getAddress(row.account),
    delegator: getAddress(row.delegator),
    generation: BigInt(row.generation),
  }))
}

export function delegatorsOf(sql: AsyncSql, chainId: number, vault: Address, account: Address, toBlock?: number) {
  return indexedDelegations(sql, chainId, vault, { account, ...(toBlock === undefined ? {} : { toBlock }) })
}

export function delegationsOf(sql: AsyncSql, chainId: number, vault: Address, wallet: Address, toBlock?: number) {
  return indexedDelegations(sql, chainId, vault, { wallet, ...(toBlock === undefined ? {} : { toBlock }) })
}
