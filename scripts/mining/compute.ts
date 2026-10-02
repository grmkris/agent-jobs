import { keccak256, toBytes, type Address, type Hex } from './viem.ts'
import type { PriceList } from './prices.ts'
import type { LeafValue } from './tree.ts'

/** The FACTORY reference price never counts below $0.0001 (18 decimals), whatever the list says. */
export const MIN_FACTORY_USD_PRICE = 10n ** 14n
export const WORKER_SHARE_PERCENT = 60n
export const CREATOR_SHARE_PERCENT = 40n

/** Where a log sits in the chain; logs compare by (block, logIndex). */
export interface LogPosition {
  block: bigint
  logIndex: number
  tx: Hex
  /** The Holding that emitted it. */
  holding: Address
}

export interface FeeCharged extends LogPosition {
  jobId: bigint
  token: Address
  worker: Address
  creator: Address
  amount: bigint
}

export interface PayoutOwed extends LogPosition {
  jobId: bigint
  to: Address
  token: Address
  amount: bigint
}

export interface OwedWithdrawn extends LogPosition {
  to: Address
  token: Address
  amount: bigint
}

export type FeeStatus = 'counted' | 'unpriced' | 'owed-to-treasury'

export interface FeeRecord {
  fee: FeeCharged
  status: FeeStatus
  /** USD value, 18 decimals, rounded down; 0 unless counted. */
  usd: bigint
}

export interface EpochResult {
  fees: FeeRecord[]
  feeUsd: bigint
  factoryUsdPrice: bigint
  /** 0.5 × feeUsd ÷ factoryUsdPrice, in FACTORY wei. */
  demand: bigint
  emission: bigint
  /** One leaf per account, ascending by address; amounts rounded down, zero amounts dropped. */
  leaves: { account: Address; amount: bigint }[]
  total: bigint
}

const after = (a: LogPosition, b: LogPosition) => a.block > b.block || (a.block === b.block && a.logIndex > b.logIndex)

/**
 * The treasury's `PayoutOwed` for a fee, if its transfer may have been refused. `_settle` emits `FeeCharged`, then pays
 * the worker, then the treasury, each refusal becoming a `PayoutOwed` (same transaction, Holding, job and token). The
 * treasury's leg is exactly `FeeCharged.amount`, so a refused leg is the treasury's when it is not to the worker, or
 * when its amount is the fee's (B8-SEC-001: a worker that is also the treasury, or a worker leg of the same amount,
 * is read as the treasury's, failing closed).
 */
export function treasuryOwed(fee: FeeCharged, owed: readonly PayoutOwed[]): PayoutOwed | undefined {
  const legs = owed.filter(o => o.tx === fee.tx && o.holding === fee.holding && o.jobId === fee.jobId && o.token === fee.token && after(o, fee)
    && (o.to !== fee.worker || o.amount === fee.amount))
  return legs.length === 0 ? undefined : legs.reduce((a, b) => (after(b, a) ? b : a))
}

/**
 * The epoch's emission and leaves (ADR-0011, D12 #2, D17):
 * - a fee counts only in a token on the signed price list, and only once the treasury holds it: a fee whose treasury
 *   transfer became `PayoutOwed` counts only if the treasury withdrew that token's owed balance later in the window;
 * - emission = min(budget, 0.5 × Σ fee USD ÷ max(FACTORY price, $0.0001));
 * - 60 % to workers and 40 % to creators, pro rata by fee USD; one leaf per account; each part rounded down;
 * - total = Σ leaves.
 */
export function computeEpoch(input: {
  fees: readonly FeeCharged[]
  owed: readonly PayoutOwed[]
  withdrawals: readonly OwedWithdrawn[]
  prices: PriceList
  budget: bigint
}): EpochResult {
  const price = new Map(input.prices.tokens.map(t => [t.token, t]))
  const fees: FeeRecord[] = input.fees.map(fee => {
    const p = price.get(fee.token)
    if (p === undefined) return { fee, status: 'unpriced', usd: 0n }
    const owed = treasuryOwed(fee, input.owed)
    if (owed !== undefined && !input.withdrawals.some(w => w.holding === owed.holding && w.to === owed.to && w.token === owed.token && after(w, owed))) {
      return { fee, status: 'owed-to-treasury', usd: 0n }
    }
    return { fee, status: 'counted', usd: (fee.amount * p.usdPrice) / 10n ** BigInt(p.decimals) }
  })
  const feeUsd = fees.reduce((sum, r) => sum + r.usd, 0n)
  const factoryUsdPrice = input.prices.factoryUsdPrice > MIN_FACTORY_USD_PRICE ? input.prices.factoryUsdPrice : MIN_FACTORY_USD_PRICE
  const demand = (feeUsd * 10n ** 18n) / (2n * factoryUsdPrice)
  const emission = demand < input.budget ? demand : input.budget

  const byWorker = new Map<Address, bigint>()
  const byCreator = new Map<Address, bigint>()
  for (const r of fees) {
    if (r.usd === 0n) continue
    byWorker.set(r.fee.worker, (byWorker.get(r.fee.worker) ?? 0n) + r.usd)
    byCreator.set(r.fee.creator, (byCreator.get(r.fee.creator) ?? 0n) + r.usd)
  }
  const amounts = new Map<Address, bigint>()
  if (feeUsd > 0n) {
    const workerPool = (emission * WORKER_SHARE_PERCENT) / 100n
    const creatorPool = (emission * CREATOR_SHARE_PERCENT) / 100n
    for (const [account, usd] of byWorker) amounts.set(account, (amounts.get(account) ?? 0n) + (workerPool * usd) / feeUsd)
    for (const [account, usd] of byCreator) amounts.set(account, (amounts.get(account) ?? 0n) + (creatorPool * usd) / feeUsd)
  }
  const leaves = [...amounts]
    .filter(([, amount]) => amount > 0n)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([account, amount]) => ({ account, amount }))
  return { fees, feeUsd, factoryUsdPrice, demand, emission, leaves, total: leaves.reduce((s, l) => s + l.amount, 0n) }
}

export const leafValues = (epoch: bigint, leaves: EpochResult['leaves']): LeafValue[] =>
  leaves.map(l => [epoch.toString(), l.account, l.amount.toString()] as const)

/** keccak256 of the UTF-8 bytes of `JSON.stringify(inputs)`, exactly as `inputs` appears in epoch-<n>.json. */
export const dataHashOf = (inputs: unknown): Hex => keccak256(toBytes(JSON.stringify(inputs)))
