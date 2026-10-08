/** Validate a complete RPC batch before any accounting cursor can advance. */
import { type Address, type Hex, isAddress, isHex } from 'viem'
import { Schema } from 'effect'

export interface AuditBlock {
  number: bigint
  transactions: Array<{ from: Address; hash: Hex }>
}

const RpcResponse = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: Schema.Int,
  result: Schema.optional(
    Schema.Struct({
      number: Schema.String,
      transactions: Schema.Array(Schema.Struct({ from: Schema.String, hash: Schema.String })),
    }),
  ),
  error: Schema.optional(Schema.Unknown),
})
type RpcResponse = Schema.Schema.Type<typeof RpcResponse>

function decode(item: unknown): RpcResponse {
  try {
    return Schema.decodeUnknownSync(RpcResponse)(item)
  } catch {
    throw new Error('P8_AUDIT_BLOCK_MISSING')
  }
}

function transactions(block: NonNullable<RpcResponse['result']>): AuditBlock['transactions'] {
  return block.transactions.map((tx) => {
    if (!isAddress(tx.from, { strict: false }) || !isHex(tx.hash, { strict: true }) || tx.hash.length !== 66)
      throw new Error('P8_AUDIT_TRANSACTION_MALFORMED')
    return { from: tx.from, hash: tx.hash }
  })
}

export function auditBlocks(payload: unknown, numbers: readonly bigint[]): AuditBlock[] {
  if (!Array.isArray(payload) || payload.length !== numbers.length) throw new Error('P8_AUDIT_BLOCK_MISSING')
  const blocks = new Map<number, AuditBlock>()
  for (const raw of payload) {
    const item = decode(raw)
    if (!Number.isSafeInteger(item.id) || item.id < 1 || item.id > numbers.length || blocks.has(item.id))
      throw new Error('P8_AUDIT_BLOCK_MISSING')
    if (item.error !== undefined || item.result === undefined) throw new Error('P8_AUDIT_BLOCK_MISSING')
    if (!/^0x[0-9a-fA-F]+$/.test(item.result.number) || BigInt(item.result.number) !== numbers[item.id - 1])
      throw new Error('P8_AUDIT_BLOCK_MISMATCH')
    blocks.set(item.id, { number: BigInt(item.result.number), transactions: transactions(item.result) })
  }
  return numbers.map((_, index) => blocks.get(index + 1)!)
}
