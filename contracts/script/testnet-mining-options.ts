import { reserveAbi } from '../../scripts/mining/chain.ts'
import type { Address, PublicClient } from '../../scripts/mining/viem.ts'

/** Explicit selection; never guess an earned epoch or reuse another epoch's directory. */
export function miningOptions(args: string[]) {
  const [inputArg, outArg, flag, claimKeyEnv, epochFlag, epochArg] = args
  if (!inputArg || !outArg || flag !== '--claim-key-env' || !claimKeyEnv || !/^[A-Z][A-Z0-9_]*$/.test(claimKeyEnv)
    || ![4, 6].includes(args.length) || (args.length === 6 && (epochFlag !== '--epoch' || !epochArg || !/^(0|[1-9][0-9]*)$/.test(epochArg)))) {
    throw new Error('usage: bash contracts/script/mine-epoch0-testnet.sh <unsigned-prices.json> <output-dir> --claim-key-env <ENV_NAME> [--epoch <n>]')
  }
  const epoch = BigInt(epochArg ?? '0')
  if (epoch >= 2n ** 256n) throw new Error('epoch exceeds uint256')
  return { inputArg, outArg, claimKeyEnv, epoch }
}

export function requirePriceEpoch(input: unknown, epoch: bigint) {
  const value = input as { epoch?: unknown; message?: { epoch?: unknown } } | null
  if ((value?.message?.epoch ?? value?.epoch) !== epoch.toString()) throw new Error('prices must name the selected epoch')
}

export class EpochNotEnded extends Error {}

/** Before reading keys, signing or creating a journal: both heads must pass the deployed boundary. */
export async function requireEndedEpoch(client: Pick<PublicClient, 'readContract' | 'getBlock'>, reserve: Address, epoch: bigint) {
  const end = await client.readContract({ address: reserve, abi: reserveAbi, functionName: 'epochEnd', args: [epoch] })
  const [latest, finalized] = await Promise.all([client.getBlock(), client.getBlock({ blockTag: 'finalized' })])
  if (latest.timestamp < end || finalized.timestamp < end) throw new EpochNotEnded(`epoch ${epoch} not ended: cutoff ${end}; latest=${latest.timestamp} finalized=${finalized.timestamp}`)
}
