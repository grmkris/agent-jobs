/** Durable event ownership and preparation-time checks shared by wallet and task operations. */
import type { Ctx } from '@sidequest/sdk'
import type { TransactionReceipt } from 'viem'
import { BoardError } from './board-error.ts'
import type { OperationRow, Sql } from './store.ts'

export async function receiptTimestamp(ctx: Ctx, receipt: TransactionReceipt, reportedHash: string): Promise<number> {
  if (
    receipt.blockNumber === undefined ||
    receipt.blockNumber === null ||
    receipt.transactionHash?.toLowerCase() !== reportedHash.toLowerCase()
  )
    throw new BoardError('chain', 'the reported receipt is missing canonical transaction or block metadata')
  const block = await ctx.publicClient.getBlock({ blockNumber: receipt.blockNumber })
  return Number(block.timestamp)
}

function legacyReceiptConfirmed(sql: Sql, hash: string): boolean {
  // Older confirmations did not record a log index. Fail closed for that transaction rather than replaying it.
  const legacy = sql.all<{ id: string }>(
    `SELECT id FROM operations WHERE status='confirmed' AND lower(tx_hash)=lower(?)
    AND NOT EXISTS (SELECT 1 FROM operation_receipts WHERE operation_id=operations.id) LIMIT 1`,
    hash,
  )
  return legacy.length > 0
}

export function consumedOperationEvents(sql: Sql, chainId: number, receipt: TransactionReceipt): ReadonlySet<number> {
  const hash = receipt.transactionHash
  if (legacyReceiptConfirmed(sql, hash)) return new Set(receipt.logs.map((log) => log.logIndex))
  return new Set(
    sql
      .all<{ log_index: number }>(
        'SELECT log_index FROM operation_receipts WHERE chain_id=? AND tx_hash=?',
        chainId,
        hash.toLowerCase(),
      )
      .map((row) => row.log_index),
  )
}

/** Claim and confirmation commit together; a crash or concurrent poll cannot strand or double-consume an event. */
export function confirmOperationEvent(
  sql: Sql,
  event: { chainId: number; hash: string; logIndex: number; op: OperationRow; now: number; result?: unknown },
): void {
  const { chainId, hash, logIndex, op, now, result } = event
  if (sql.atomic === undefined) throw new BoardError('chain', 'atomic board storage is unavailable')
  sql.atomic(() => {
    const saved = sql.all<OperationRow>('SELECT * FROM operations WHERE id=?', op.id)[0]
    if (saved?.status !== 'prepared') return
    if (legacyReceiptConfirmed(sql, hash)) return
    sql.run(
      'INSERT OR IGNORE INTO operation_receipts (chain_id,tx_hash,log_index,operation_id) VALUES (?,?,?,?)',
      chainId,
      hash.toLowerCase(),
      logIndex,
      op.id,
    )
    const owner = sql.all<{ operation_id: string }>(
      'SELECT operation_id FROM operation_receipts WHERE chain_id=? AND tx_hash=? AND log_index=?',
      chainId,
      hash.toLowerCase(),
      logIndex,
    )[0]
    if (owner?.operation_id !== op.id) return
    const detail = result === undefined ? saved.detail : JSON.stringify({ ...JSON.parse(saved.detail ?? '{}'), result })
    sql.run(
      "UPDATE operations SET status='confirmed',tx_hash=?,detail=?,updated_at=? WHERE id=? AND status='prepared'",
      hash,
      detail,
      now,
      op.id,
    )
  })
}
