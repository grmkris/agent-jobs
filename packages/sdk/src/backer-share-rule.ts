import { decodeBackerShare } from './backer-share.ts'

export interface BackerShareSet<P> {
  position: P
  value: string
}

const comparePosition = <P>(a: P, b: P) => (a < b ? -1 : a > b ? 1 : 0)

/** Numbers, bigints and strings compare directly; structured positions supply their chain-order comparator. */
export function agentWindowShare<P>(
  sets: readonly BackerShareSet<P>[],
  windowStart: P,
  epochStart: P,
  compare: (a: P, b: P) => number = comparePosition,
): number {
  if (compare(windowStart, epochStart) > 0) throw new Error('share window starts after the epoch')
  const ordered = sets
    .filter((set) => compare(set.position, epochStart) < 0)
    .toSorted((a, b) => compare(a.position, b.position))
  const previous = ordered.filter((set) => compare(set.position, windowStart) < 0).at(-1)
  let share = previous === undefined ? 0 : decodeBackerShare(previous.value)
  for (const set of ordered) {
    if (compare(set.position, windowStart) >= 0) share = Math.max(share, decodeBackerShare(set.value))
  }
  return share
}

/** A second identity cannot lower the share already offered by the same worker wallet. */
export function walletShare<ID>(agentIds: Iterable<ID>, shareOf: (agentId: ID) => number): number {
  let share = 0
  for (const id of agentIds) share = Math.max(share, shareOf(id))
  return share
}
