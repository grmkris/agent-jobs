/** Vault event discovery preserves generation at each deposit, including resets in the same block. */
import type { Address } from 'viem'

export interface DelegationCandidate {
  readonly account: Address
  readonly delegator: Address
  readonly generation: bigint
}

export type StakeLedgerEvent = {
  readonly account: Address
  readonly blockNumber: bigint
  readonly logIndex: number
} & (
  | { readonly name: 'Delegated'; readonly delegator: Address }
  | { readonly name: 'PoolReset'; readonly generation: bigint }
)

export function delegationCandidates(
  events: readonly StakeLedgerEvent[],
  filters: { account?: Address; delegator?: Address } = {},
): DelegationCandidate[] {
  const generations = new Map<string, bigint>()
  const positions = new Map<string, DelegationCandidate>()
  const ordered = events.toSorted((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  )
  for (const event of ordered) {
    const account = event.account.toLowerCase()
    if (event.name === 'PoolReset') {
      generations.set(account, event.generation)
      continue
    }
    if (filters.account !== undefined && account !== filters.account.toLowerCase()) continue
    if (filters.delegator !== undefined && event.delegator.toLowerCase() !== filters.delegator.toLowerCase()) continue
    positions.set(`${account}:${event.delegator.toLowerCase()}`, {
      account: event.account,
      delegator: event.delegator,
      generation: generations.get(account) ?? 0n,
    })
  }
  return [...positions.values()]
}
