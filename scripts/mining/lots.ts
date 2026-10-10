/** Note 17 section 6, rev 9. Amounts are SIDE wei; a lot remains usable through its fourth successor. */
export const MINING_RESERVE = 500_000_000n * 10n ** 18n
export const WEEKLY_BUDGET = MINING_RESERVE / 52n
export const ROLLOVER_EPOCHS = 4n

export interface EpochFunding {
  epoch: bigint
  amount: bigint
}

export interface MiningLot {
  epoch: bigint
  scheduled: bigint
  remaining: bigint
}

/** Mirrors MiningSchedule.cumulativeBudget, including integer rounding and the reserve ceiling. */
export function cumulativeBudget(epoch: bigint): bigint {
  if (epoch < 0n) throw new Error('mining epoch must be nonnegative')
  let total = (WEEKLY_BUDGET * 3n) / 7n
  const eras = epoch / 26n
  for (let era = 0n; era < eras && era < 256n && total < MINING_RESERVE; era++) {
    total += 26n * (WEEKLY_BUDGET >> era)
  }
  if (eras < 256n) total += (epoch % 26n) * (WEEKLY_BUDGET >> eras)
  return total < MINING_RESERVE ? total : MINING_RESERVE
}

export function scheduledLot(epoch: bigint): bigint {
  return cumulativeBudget(epoch) - (epoch === 0n ? 0n : cumulativeBudget(epoch - 1n))
}

/** Mutates only the supplied replay's lots, consuming the oldest live lot first. */
function consume(lots: MiningLot[], epoch: bigint, amount: bigint): void {
  if (amount < 0n) throw new Error('negative mining funding')
  let rest = amount
  for (const lot of lots) {
    if (lot.epoch + ROLLOVER_EPOCHS < epoch) continue
    const used = lot.remaining < rest ? lot.remaining : rest
    lot.remaining -= used
    rest -= used
    if (rest === 0n) return
  }
  if (rest > 0n) throw new Error(`epoch ${epoch} funding exceeds its live lots`)
}

/**
 * Replay public EpochFunded amounts for epochs 0..n-1. Current-epoch funding is deliberately excluded:
 * a partial rerun must produce the original emission, leaves, root and canonical inputs.
 */
export function replayLots(epoch: bigint, funding: readonly EpochFunding[]) {
  if (epoch < 0n) throw new Error('mining epoch must be nonnegative')
  const totals = new Map<bigint, bigint>()
  let previous = 0n
  for (const event of funding) {
    if (event.epoch < previous || event.epoch > epoch || event.amount <= 0n) {
      throw new Error('mining funding must be positive and in epoch order; later epochs cannot precede this run')
    }
    previous = event.epoch
    totals.set(event.epoch, (totals.get(event.epoch) ?? 0n) + event.amount)
  }
  const lots: MiningLot[] = []
  // The fixed reserve schedule ends at epoch 182. No iteration over an unbounded user-supplied epoch.
  for (let n = 0n; n <= epoch && n <= 182n; n++) {
    const scheduled = scheduledLot(n)
    if (scheduled > 0n) lots.push({ epoch: n, scheduled, remaining: scheduled })
    if (n < epoch) consume(lots, n, totals.get(n) ?? 0n)
  }
  for (const [n, amount] of totals) {
    if (n > 182n && n < epoch) consume(lots, n, amount)
  }
  const usable = lots.filter((lot) => lot.epoch + ROLLOVER_EPOCHS >= epoch)
  const expired = lots.filter((lot) => lot.epoch + ROLLOVER_EPOCHS < epoch)
  const available = usable.reduce((sum, lot) => sum + lot.remaining, 0n)
  const fundedThis = totals.get(epoch) ?? 0n
  if (fundedThis > available) throw new Error('current epoch funding exceeds its live lots')
  const fundedBefore = [...totals].reduce((sum, [n, amount]) => (n < epoch ? sum + amount : sum), 0n)
  return { usable, expired, available, fundedBefore, fundedThis }
}

/** Excess funding is an inconsistent input, never silently accepted or funded a second time. */
export function fundingRemainder(total: bigint, fundedThis: bigint): bigint {
  if (total < 0n || fundedThis < 0n || fundedThis > total)
    throw new Error('epoch already funded beyond its computed leaf total')
  return total - fundedThis
}
