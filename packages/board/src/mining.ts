/** Epoch consumers only: verify the artifact's claims against the Safe-published distributor root. */
import * as sdk from '@sidequest/sdk'
import {
  type Address,
  type Hex,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  maxUint256,
  stringToHex,
} from 'viem'
import { transaction } from './sidequest.ts'

export interface MiningSource {
  load(epoch: string): Promise<unknown | null>
}
export interface MiningProof {
  epoch: string
  account: Address
  token: Address
  amount: string
  proof: Hex[]
  root: Hex
  dataHash: Hex
  eligible: boolean
  claimed: boolean
  transactions: sdk.TxRequest[]
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const uint = (value: unknown): string => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) > maxUint256)
    throw new Error('mining integers must be canonical uint256 decimal strings')
  return value
}
export const miningEpoch = (value: string) => uint(value)
const hash = (value: unknown): Hex => {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{64}$/.test(value)) throw new Error('mining hashes must be bytes32')
  return value.toLowerCase() as Hex
}

/** OZ StandardMerkleTree's double-hashed ABI leaf and sorted-pair MerkleProof hashing. */
export function verifyMiningClaim(root: Hex, epoch: string, account: Address, amount: string, proof: Hex[]): boolean {
  const leaf = keccak256(
    keccak256(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }],
        [BigInt(uint(epoch)), account, BigInt(uint(amount))],
      ),
    ),
  )
  const computed = proof.reduce((node, sibling) => {
    const other = hash(sibling)
    return keccak256(node < other ? concat([node, other]) : concat([other, node]))
  }, leaf)
  return same(computed, hash(root))
}

export async function miningProof(
  ctx: sdk.Ctx,
  account: Address,
  epochText: string,
  source: MiningSource,
): Promise<MiningProof> {
  const epoch = miningEpoch(epochText),
    h = ctx.deployment.sidequest
  if (h === null) throw new Error('work mining requires a deployed Sidequest v1 distributor')
  const payload = await source.load(epoch)
  if (payload === null || typeof payload !== 'object')
    throw new Error(`mining artifact epoch-${epoch}.json is unavailable`)
  const file = payload as {
    chainId: number
    epoch: string
    total: string
    root: Hex
    dataHash: Hex
    inputs: unknown
    claims: Record<string, { amount: string; proof: Hex[] }>
  }
  if (file.chainId !== ctx.deployment.chainId || uint(file.epoch) !== epoch || uint(file.total) === '0')
    throw new Error('mining artifact has the wrong chain, epoch or total')
  const artifactRoot = hash(file.root),
    dataHash = hash(file.dataHash),
    total = BigInt(file.total)
  if (file.inputs === undefined || keccak256(stringToHex(JSON.stringify(file.inputs))) !== dataHash)
    throw new Error('mining artifact data hash does not match its contents')
  if (file.claims === null || typeof file.claims !== 'object' || Array.isArray(file.claims))
    throw new Error('mining artifact claims are unavailable')
  const key = account.toLowerCase(),
    match = Object.hasOwn(file.claims, key) ? file.claims[key] : undefined
  const amount = match === undefined ? '0' : uint(match.amount)
  const proof = match?.proof ?? []
  if (
    match !== undefined &&
    (amount === '0' ||
      BigInt(amount) > total ||
      !Array.isArray(match.proof) ||
      proof.length > 256 ||
      !verifyMiningClaim(artifactRoot, epoch, account, amount, proof))
  )
    throw new Error('mining artifact contains an invalid claim proof')
  const [root, claimed] = await Promise.all([
    ctx.publicClient.readContract({
      address: h.distributor,
      abi: sdk.epochDistributorAbi,
      functionName: 'rootOf',
      args: [BigInt(epoch)],
    }),
    ctx.publicClient.readContract({
      address: h.distributor,
      abi: sdk.epochDistributorAbi,
      functionName: 'isClaimed',
      args: [BigInt(epoch), account],
    }),
  ])
  if (!same(root.root, artifactRoot) || root.total !== total || !same(root.dataHash, dataHash))
    throw new Error('mining artifact does not match the distributor’s current root')
  const transactions =
    match === undefined || claimed
      ? []
      : [
          transaction(
            ctx,
            'Claim work mining into your SIDE stake',
            h.distributor,
            encodeFunctionData({
              abi: sdk.epochDistributorAbi,
              functionName: 'claim',
              args: [BigInt(epoch), account, BigInt(amount), proof],
            }),
            500_000n,
          ),
        ]
  return {
    epoch,
    account: getAddress(account),
    token: h.factory,
    amount,
    proof,
    root: root.root,
    dataHash: root.dataHash,
    eligible: match !== undefined,
    claimed,
    transactions,
  }
}
