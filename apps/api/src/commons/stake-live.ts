import { Address, StakeReader, Unavailable } from '@sidequest/commons'
import { delegationPositions } from '@sidequest/board'
import type { AsyncSql } from '@sidequest/indexer'
import * as sdk from '@sidequest/sdk'
import { Effect, Layer, Schema } from 'effect'
import { stakingSnapshot } from '../staking-index.ts'

const wallet = (address: string) => {
  // SAFETY: Commons Address validates exactly forty hex digits before use as a viem address.
  return Schema.decodeUnknownSync(Address)(address) as `0x${string}`
}

export function stakeReaderLive(sql: AsyncSql, ctx: sdk.Ctx): StakeReader['Service'] {
  return {
    stakes: (addresses) =>
      Effect.tryPromise({
        try: async () => {
          const block = await ctx.publicClient.getBlockNumber()
          const vault = ctx.deployment.sidequest?.vault
          if (vault === undefined) throw new Error('Stake vault unavailable')
          const stake = new Map<string, bigint>()
          for (let start = 0; start < addresses.length; start += 200) {
            const chunk = addresses.slice(start, start + 200)
            const values = await ctx.publicClient.multicall({
              allowFailure: false,
              blockNumber: block,
              contracts: chunk.map((address) => ({
                address: vault,
                abi: sdk.stakeVaultAbi,
                functionName: 'stakeOf',
                args: [wallet(address)],
              })),
            })
            chunk.forEach((address, index) =>
              stake.set(address.toLowerCase(), Schema.decodeUnknownSync(Schema.BigInt)(values[index])),
            )
          }
          return { block, stake }
        },
        catch: () => new Unavailable({ message: 'Active stake reads are unavailable' }),
      }),
    backing: (address) =>
      Effect.tryPromise({
        try: async () => {
          const snapshot = await stakingSnapshot(sql, ctx, { wallet: wallet(address) }, Math.floor(Date.now() / 1000))
          const read = await delegationPositions(ctx, snapshot)
          const positions = read.positions
            .filter((p) => p.delegator.toLowerCase() === address.toLowerCase())
            .map((p) => ({ account: p.account.toLowerCase(), value: p.value }))
          return { block: snapshot.blockNumber, total: positions.reduce((sum, p) => sum + p.value, 0n), positions }
        },
        catch: () => new Unavailable({ message: 'Delegated backing reads are unavailable' }),
      }),
  }
}

export const stakeLayer = (sql: AsyncSql, ctx: sdk.Ctx) => Layer.succeed(StakeReader, stakeReaderLive(sql, ctx))
