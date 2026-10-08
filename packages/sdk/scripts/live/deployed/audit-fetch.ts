import { auditBlocks, type AuditBlock } from './audit-blocks.ts'

export async function readAuditBlocks(
  numbers: readonly bigint[],
  rpcUrl: string,
  batchFetch: typeof fetch,
): Promise<AuditBlock[]> {
  const response = await batchFetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      numbers.map((blockNumber, index) => ({
        jsonrpc: '2.0',
        id: index + 1,
        method: 'eth_getBlockByNumber',
        params: [`0x${blockNumber.toString(16)}`, true],
      })),
    ),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error('P8_AUDIT_RPC_REFUSED')
  try {
    return auditBlocks(await response.json(), numbers)
  } catch (error) {
    // Public RPCs sometimes return incomplete full-transaction batches.
    // Retry the same range in smaller batches; every response is still decoded
    // before its cursor can advance.
    if (!(error instanceof Error) || error.message !== 'P8_AUDIT_BLOCK_MISSING' || numbers.length < 2) throw error
    const middle = Math.ceil(numbers.length / 2)
    const left = await readAuditBlocks(numbers.slice(0, middle), rpcUrl, batchFetch)
    const right = await readAuditBlocks(numbers.slice(middle), rpcUrl, batchFetch)
    return [...left, ...right]
  }
}
