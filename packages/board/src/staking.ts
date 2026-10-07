/** Indexed discovery supplies owners; the vault supplies every value at one verified block. */
import * as sdk from '@sidequest/sdk'
import { getAddress, isAddress, type Address } from 'viem'

export interface PositionFilters {
  readonly wallet?: Address
  readonly account?: Address
}

export interface DelegationSnapshot {
  readonly blockNumber: bigint
  readonly candidates: readonly sdk.DelegationCandidate[]
}

export function positionFilters(
  input: { wallet?: string; account?: string },
  caller?: string,
  fail = (message: string) => new Error(message),
): PositionFilters {
  const wallet = input.wallet ?? (input.account === undefined ? caller : undefined)
  for (const [name, value] of [
    ['wallet', wallet],
    ['account', input.account],
  ] as const) {
    if (value !== undefined && (typeof value !== 'string' || !isAddress(value)))
      throw fail(`${name} must be an address`)
  }
  if (wallet === undefined && input.account === undefined) throw fail('wallet or account is required')
  return {
    ...(wallet === undefined ? {} : { wallet: getAddress(wallet) }),
    ...(input.account === undefined ? {} : { account: getAddress(input.account) }),
  }
}

export async function delegationPositions(ctx: sdk.Ctx, snapshot: DelegationSnapshot) {
  const positions = []
  const backing = new Map<string, Awaited<ReturnType<typeof sdk.getBacking>>>()
  for (const candidate of snapshot.candidates) {
    const key = candidate.account.toLowerCase()
    if (!backing.has(key))
      backing.set(key, await sdk.getBacking(ctx, candidate.account, { blockNumber: snapshot.blockNumber }))
    const position = await sdk.getPosition(ctx, candidate.account, candidate.delegator, {
      blockNumber: snapshot.blockNumber,
      knownGeneration: candidate.generation,
    })
    positions.push({ ...position, backing: backing.get(key)! })
  }
  return {
    source: 'index+vault' as const,
    blockNumber: snapshot.blockNumber,
    token: ctx.deployment.sidequest!.factory,
    vault: ctx.deployment.sidequest!.vault,
    positions,
  }
}
