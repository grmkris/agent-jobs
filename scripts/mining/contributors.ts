import type { FeeCharged, LogPosition } from './compute.ts'
import type { Address } from './viem.ts'

export interface TopUp extends LogPosition {
  jobId: bigint
  contributor: Address
  amount: bigint
  /** Holding's cumulative top-up balance, used to detect incomplete event history. */
  bonus: bigint
}

function before(a: LogPosition, b: LogPosition): boolean {
  return a.block < b.block || (a.block === b.block && a.logIndex < b.logIndex)
}

/** Creator-side fee-USD weights: base fee belongs to the publisher, bonus fee to contributors pro rata. */
export function creatorWeights(fee: FeeCharged, usd: bigint, topUps: readonly TopUp[]) {
  if (fee.bonusPart < 0n || fee.bonusPart > fee.amount) throw new Error('invalid fee bonus part')
  if (fee.bonusPart === 0n) return [{ account: fee.creator, usd }]
  const contributions = topUps.filter(topUp => topUp.holding === fee.holding && topUp.jobId === fee.jobId && before(topUp, fee))
    .toSorted((a, b) => a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1)
  let total = 0n
  for (const contribution of contributions) {
    total += contribution.amount
    if (contribution.amount <= 0n || total !== contribution.bonus) throw new Error('incomplete top-up contribution history')
  }
  if (total === 0n) throw new Error('missing top-up contribution history')
  const bonusUsd = usd * fee.bonusPart / fee.amount
  return [
    { account: fee.creator, usd: usd - bonusUsd },
    ...contributions.map(contribution => ({ account: contribution.contributor, usd: bonusUsd * contribution.amount / total })),
  ]
}
