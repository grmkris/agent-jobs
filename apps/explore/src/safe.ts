/**
 * Acting as the Safe that owns Hireling v1 (threshold 1): an owner calls `execTransaction` itself with a pre-validated
 * signature (`r` = the owner, `s` = 0, `v` = 1), which the Safe accepts because the caller is that owner. No Safe
 * transaction service and no off-chain signature. Every call is decoded back from the exact calldata before it is
 * signed (`describe`), so what the page shows is what goes out. Pure, so it is unit-tested (safe.test.ts).
 */
import { type Abi, type Address, type Hex, concat, decodeFunctionData, encodeFunctionData, pad, zeroAddress } from 'viem'

/** The Safe functions this page uses (Safe v1.3/v1.4 share them). */
export const safeAbi = [
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'execTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const

/** The owner's pre-validated signature: valid only when that owner sends the transaction. */
export const preValidated = (owner: Address): Hex => concat([pad(owner, { size: 32 }), pad('0x00', { size: 32 }), '0x01'])

/** A contract call before it is wrapped: which contract (by name, for people), the ABI and the function with args. */
export interface Call {
  contract: string
  to: Address
  abi: Abi
  functionName: string
  args?: readonly unknown[]
}

export const calldata = (c: Call): Hex => encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args ?? [] } as never)

/**
 * `execTransaction` on `safe` for `inner`, from `owner`: a plain call (operation 0), no refund, no gas price, so a
 * failing inner call fails the whole transaction instead of being recorded as a failed Safe transaction.
 */
export function execTransaction(owner: Address, inner: { to: Address; data: Hex }): Hex {
  return encodeFunctionData({
    abi: safeAbi,
    functionName: 'execTransaction',
    args: [inner.to, 0n, inner.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, preValidated(owner)],
  })
}

/** A call as people read it: the function and each argument by name, decoded from the calldata itself. */
export function describe(abi: Abi, data: Hex): { functionName: string; args: Array<[string, string]> } {
  const { functionName, args = [] } = decodeFunctionData({ abi, data })
  const fn = abi.find((item) => item.type === 'function' && item.name === functionName && item.inputs.length === args.length)
  const inputs = fn !== undefined && fn.type === 'function' ? fn.inputs : []
  return { functionName, args: args.map((value, i) => [inputs[i]?.name || `arg${i}`, show(value)]) }
}

function show(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`
  if (value !== null && typeof value === 'object') return `{ ${Object.entries(value).map(([k, v]) => `${k}: ${show(v)}`).join(', ')} }`
  return String(value)
}
