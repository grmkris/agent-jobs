/** Advisory activation credit from the live fee schedule; held backing can lower the eventual boost. */
import { BoardError } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import { Schema } from 'effect'
import { rpcUrlForNetwork } from '@sidequest/indexer/network'

export function miningQuote(feeBps: number, bps: readonly number[]) {
  if (
    bps.length !== 4 ||
    bps.some(
      (rate, index) => !Number.isInteger(rate) || rate <= 0 || rate > 10000 || (index > 0 && rate >= bps[index - 1]!),
    )
  )
    throw new BoardError('unavailable', 'the mining fee schedule is invalid')
  const tier = bps.indexOf(feeBps)
  if (tier === -1) throw new BoardError('unavailable', 'the fee schedule changed; re-quote activation')
  const floorBps = bps[3]!
  const boostBps = [4000, 6000, 8000, 10000][tier]!
  return { floorBps, tier, boostBps, creditBps: Number((BigInt(floorBps) * BigInt(boostBps)) / 10000n) }
}

export async function quotedMining(network: sdk.Network, feeBps: number, context: unknown) {
  const { rpcUrl: configuredRpc } = Schema.decodeUnknownSync(Schema.Struct({ rpcUrl: Schema.optional(Schema.String) }))(
    context,
  )
  const rpcUrl = configuredRpc ?? rpcUrlForNetwork()
  if (rpcUrl === undefined || rpcUrl === '') throw new BoardError('unavailable', 'mining quote reads are unavailable')
  const ctx = sdk.context(network, 'main', rpcUrl)
  const h = ctx.deployment.sidequest
  if (h === null) throw new BoardError('unavailable', 'mining quote reads are unavailable')
  const schedule = await ctx.publicClient.readContract({
    address: h.feeSchedule,
    abi: sdk.feeScheduleAbi,
    functionName: 'schedule',
  })
  return miningQuote(feeBps, schedule.bps)
}
