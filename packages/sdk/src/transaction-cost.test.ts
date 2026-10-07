import { type PublicClient } from 'viem'
import { expect, it, vi } from 'vitest'
import { transactionFees, transactionGas } from './transaction-cost.ts'

const gwei = 1_000_000_000n
const address = '0x1111111111111111111111111111111111111111' as const
const request = { account: { address, type: 'json-rpc' as const }, to: address, data: '0xab' as const, value: 0n }
function fees(priority = 2n * gwei) {
  return { getGasPrice: vi.fn(async () => 102n * gwei), getBlock: vi.fn(async () => ({ baseFeePerGas: 100n * gwei })),
    estimateMaxPriorityFeePerGas: vi.fn(async () => priority) }
}
it('uses the RPC tip rather than the total price and caps max fee at twice the base', async () => {
  expect(await transactionFees(fees() as unknown as PublicClient)).toEqual({ gasPrice: 102n * gwei, baseFeePerGas: 100n * gwei,
    maxFeePerGas: 200n * gwei, maxPriorityFeePerGas: 2n * gwei })
})
it.each([[0n, gwei], [200n * gwei, 102n * gwei]])('clamps the suggested tip %s into the allowed range', async (suggested, expected) => {
  expect((await transactionFees(fees(suggested) as unknown as PublicClient)).maxPriorityFeePerGas).toBe(expected)
})
it('falls back to price minus base when the priority RPC is unavailable', async () => {
  const client = fees(); client.estimateMaxPriorityFeePerGas.mockRejectedValue(new Error('method unavailable'))
  expect((await transactionFees(client as unknown as PublicClient)).maxPriorityFeePerGas).toBe(2n * gwei)
  client.getGasPrice.mockResolvedValue(99n * gwei)
  expect((await transactionFees(client as unknown as PublicClient)).maxPriorityFeePerGas).toBe(gwei)
})
it('refuses an unavailable base fee rather than treating the total price as a base', async () => {
  const client = fees(); client.getBlock.mockResolvedValue({ baseFeePerGas: null } as never)
  await expect(transactionFees(client as unknown as PublicClient)).rejects.toThrow('base fee')
})
it('caps a tip at twice a low base fee so the signed EIP-1559 transaction remains valid', async () => {
  const client = fees(2n * gwei); client.getBlock.mockResolvedValue({ baseFeePerGas: 200_000_000n } as never)
  const result = await transactionFees(client as unknown as PublicClient)
  expect(result.maxFeePerGas).toBe(400_000_000n)
  expect(result.maxPriorityFeePerGas).toBe(400_000_000n)
})
function gas() {
  return { estimateGas: vi.fn(async () => 100_001n), call: vi.fn(async () => ({ data: '0x' })) }
}
it('sizes a successful estimate by 1.25 plus 10k, ignoring a larger fallback', async () => {
  const client = gas()
  expect(await transactionGas(client as unknown as PublicClient, request, 1_200_000n)).toBe(135_002n)
  expect(client.call).toHaveBeenCalledExactlyOnceWith({ ...request, gas: 135_002n })
})
it('sizes by an explicit margin, and refuses one outside 100–200', async () => {
  const client = gas()
  expect(await transactionGas(client as unknown as PublicClient, request, { fallback: 1_200_000n, margin: 110 })).toBe(120_002n)
  expect(client.call).toHaveBeenCalledExactlyOnceWith({ ...request, gas: 120_002n })
  for (const margin of [99, 201, 1.5]) await expect(transactionGas(client as unknown as PublicClient, request, { margin })).rejects.toThrow('Gas margin is invalid')
})
it('falls back when the tighter margin cannot run, never broadcasting a limit that failed simulation', async () => {
  const client = gas()
  client.call.mockRejectedValueOnce(new Error('out of gas'))
  expect(await transactionGas(client as unknown as PublicClient, request, { fallback: 1_200_000n, margin: 110 })).toBe(1_200_000n)
  expect((client.call.mock.calls as unknown as Array<[{ gas: bigint }]>).map(([call]) => call.gas)).toEqual([120_002n, 1_200_000n])
})
it('raises a payout estimate to its explicit floor before simulation', async () => {
  const client = gas()
  expect(await transactionGas(client as unknown as PublicClient, request, { fallback: 1_200_000n, floor: 1_200_000n })).toBe(1_200_000n)
  expect(client.call).toHaveBeenCalledExactlyOnceWith({ ...request, gas: 1_200_000n })
})
it.each(['unavailable', 'underestimated'])('uses a separately simulated protocol fallback when estimation is %s', async kind => {
  const client = gas()
  if (kind === 'unavailable') client.estimateGas.mockRejectedValue(new Error('unsupported estimate'))
  else client.call.mockRejectedValueOnce(new Error('CoreGasTooLow'))
  expect(await transactionGas(client as unknown as PublicClient, request, 1_200_000n)).toBe(1_200_000n)
  expect(client.call).toHaveBeenLastCalledWith({ ...request, gas: 1_200_000n })
})
it('a real revert fails both estimates and cannot authorize a send through the fallback', async () => {
  const client = gas(); client.estimateGas.mockRejectedValue(new Error('wrong caller')); client.call.mockRejectedValue(new Error('wrong caller'))
  await expect(transactionGas(client as unknown as PublicClient, request, 1_200_000n)).rejects.toThrow('wrong caller')
  await expect(transactionGas(client as unknown as PublicClient, request)).rejects.toThrow('wrong caller')
})

it('keeps the larger estimate when an explicit payout floor is smaller, and honors the floor when estimation fails', async () => {
  const client = gas()
  expect(await transactionGas(client as unknown as PublicClient, request, { floor: 100_000n })).toBe(135_002n)
  client.estimateGas.mockRejectedValue(new Error('unsupported estimate'))
  expect(await transactionGas(client as unknown as PublicClient, request, { floor: 1_200_000n, fallback: 100_000n })).toBe(1_200_000n)
  expect(client.call).toHaveBeenLastCalledWith({ ...request, gas: 1_200_000n })
})
