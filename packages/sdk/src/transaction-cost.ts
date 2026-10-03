import type { Account, Address, Hex, PublicClient, SignedAuthorization } from 'viem'

const GWEI = 1_000_000_000n
const min = (a: bigint, b: bigint) => a < b ? a : b
const max = (a: bigint, b: bigint) => a > b ? a : b

/** gasPrice includes the base fee; it must never be reused as the priority fee. */
export async function transactionFees(client: Pick<PublicClient, 'getGasPrice' | 'getBlock' | 'estimateMaxPriorityFeePerGas'>) {
  const [gasPrice, block] = await Promise.all([client.getGasPrice(), client.getBlock()])
  const baseFeePerGas = block.baseFeePerGas
  if (baseFeePerGas === null || baseFeePerGas === undefined || baseFeePerGas <= 0n || gasPrice <= 0n)
    throw new Error('EIP-1559 base fee is unavailable')
  const suggested = await client.estimateMaxPriorityFeePerGas().catch(() => gasPrice - baseFeePerGas)
  const maxFeePerGas = baseFeePerGas * 2n
  // A local EVM fork can expose a near-zero base fee while still reporting a normal tip. The
  // EIP-1559 invariant wins in that case: cap the tip at maxFee rather than signing an invalid tx.
  const maxPriorityFeePerGas = min(maxFeePerGas, min(gasPrice, max(GWEI, suggested)))
  if (maxPriorityFeePerGas <= 0n) throw new Error('EIP-1559 fee cap is unavailable')
  return { gasPrice, baseFeePerGas, maxFeePerGas, maxPriorityFeePerGas }
}

type GasRequest = { account: Account; to: Address; data: Hex; value?: bigint; authorizationList?: SignedAuthorization<number>[] }
/** Monad charges the full limit. Explicit protocol limits are validated fallbacks, not minimum estimates. */
export async function transactionGas(client: Pick<PublicClient, 'estimateGas' | 'call'>, request: GasRequest, fallback?: bigint) {
  let gas: bigint
  try {
    const estimated = await client.estimateGas(request)
    if (estimated <= 0n) throw new Error('Gas estimate is invalid')
    gas = (estimated * 125n + 99n) / 100n + 10_000n
  } catch (error) {
    if (fallback === undefined || fallback <= 0n) throw error
    await client.call({ ...request, gas: fallback })
    return fallback
  }
  try { await client.call({ ...request, gas }) }
  catch (error) {
    if (fallback === undefined || fallback <= gas) throw error
    // A low estimate can miss a contract's explicit gas reserve. The larger limit must simulate too;
    // a wrong caller, expired action or other real revert never becomes permission to broadcast.
    await client.call({ ...request, gas: fallback })
    return fallback
  }
  return gas
}
