import { type Address, type Hex, encodeAbiParameters, decodeFunctionData, encodeFunctionData, slice } from 'viem'
import { identityAbi } from './abi/identity.ts'

export const BACKER_SHARE_KEY = 'sidequest.backerShareBps'

export function encodeBackerShare(bps: number): Hex {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000)
    throw new Error('backer share must be an integer from 0 to 10000 basis points')
  return encodeAbiParameters([{ type: 'uint16' }], [bps])
}

/** Unset or malformed metadata opts out; oversized uint values saturate at the full slice. */
export function decodeBackerShare(bytes: string): number {
  if (!/^0x[0-9a-fA-F]{64}$/.test(bytes)) return 0
  const bps = BigInt(bytes)
  return bps > 10000n ? 10000 : Number(bps)
}

function backerShareCalldata(agentId: bigint, bps: number) {
  return encodeFunctionData({
    abi: identityAbi,
    functionName: 'setMetadata',
    args: [agentId, BACKER_SHARE_KEY, encodeBackerShare(bps)],
  })
}

/** Canonical setMetadata layout: pin every byte after the agent ID except the final uint16. */
export const BACKER_SHARE_CALLDATA_LAYOUT = {
  length: 228,
  agentIdOffset: 4,
  fixedOffset: 36,
  fixedBytes: slice(backerShareCalldata(0n, 0), 36, 226),
} as const

export function prepareBackerShare(identity: Address, agentId: bigint | string, bps: number) {
  return {
    to: identity,
    data: backerShareCalldata(BigInt(agentId), bps),
    value: '0',
  }
}

type BackerShareReader = {
  readContract: (request: {
    address: Address
    abi: typeof identityAbi
    functionName: 'getMetadata'
    args: readonly [bigint, string]
  }) => Promise<Hex>
}

/** RPC failures stay unreadable; a successful empty metadata read is the default zero share. */
export async function readBackerShare(publicClient: BackerShareReader, identity: Address, agentId: bigint | string) {
  return decodeBackerShare(
    await publicClient.readContract({
      address: identity,
      abi: identityAbi,
      functionName: 'getMetadata',
      args: [BigInt(agentId), BACKER_SHARE_KEY],
    }),
  )
}

export function backerShareCalls(value: unknown): number {
  const calls = Number(value)
  if (calls !== value || !Number.isSafeInteger(calls) || calls < 1 || calls > 20)
    throw new Error('calls must be 1 to 20')
  return calls
}

export function checkBackerShareExecution(
  terms: { registry: Address; agentId: bigint },
  execution: { target: Address; value: bigint; callData: Hex },
) {
  if (execution.target.toLowerCase() !== terms.registry.toLowerCase() || execution.value !== 0n)
    throw new Error('the call is outside the permitted backer share')
  try {
    const decoded = decodeFunctionData({ abi: identityAbi, data: execution.callData })
    if (decoded.functionName !== 'setMetadata') throw new Error('not metadata')
    const [agentId, key, value] = decoded.args
    if (agentId !== terms.agentId || key !== BACKER_SHARE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(value))
      throw new Error('different metadata')
    const bps = BigInt(value)
    if (
      bps > 10000n ||
      prepareBackerShare(terms.registry, agentId, Number(bps)).data.toLowerCase() !== execution.callData.toLowerCase()
    )
      throw new Error('noncanonical share')
  } catch {
    throw new Error('the calldata is outside the permitted backer share')
  }
}
