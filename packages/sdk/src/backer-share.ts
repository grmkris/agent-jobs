import { type Address, type Hex, encodeAbiParameters, encodeFunctionData } from 'viem'
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

export function prepareBackerShare(identity: Address, agentId: bigint | string, bps: number) {
  return {
    to: identity,
    data: encodeFunctionData({
      abi: identityAbi,
      functionName: 'setMetadata',
      args: [BigInt(agentId), BACKER_SHARE_KEY, encodeBackerShare(bps)],
    }),
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
