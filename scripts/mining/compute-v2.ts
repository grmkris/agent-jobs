import { creatorWeights, type TopUp } from './contributors.ts'
import {
  MIN_SIDE_USD_PRICE,
  treasuryOwed,
  type BackerPositionInput,
  type BackerWorkerInput,
  type EpochResult,
  type FeeCharged,
  type FeeRecord,
  type OwedWithdrawn,
  type PayoutOwed,
} from './compute.ts'
import { chainOrder, creditOf, scheduleAt, type ActivationRecord, type ScheduleRecord } from './credit.ts'
import { V2_RULE } from './rule.ts'
import type { PriceList } from './prices.ts'
import type { Address } from './viem.ts'

export interface WorkerStake {
  worker: Address
  start: bigint
  end: bigint
}

export interface V2FeeRecord extends FeeRecord {
  credit: ReturnType<typeof creditOf> | null
}

export interface EpochResultV2 extends EpochResult {
  fees: V2FeeRecord[]
  /** feeUsd retains the v1 output field name; both contain counted credit USD in v2. */
  creditUsd: bigint
  backerPositions: BackerPositionInput[]
}

export interface EpochInputV2 {
  fees: readonly FeeCharged[]
  owed: readonly PayoutOwed[]
  withdrawals: readonly OwedWithdrawn[]
  prices: PriceList
  budget: bigint
  topUps?: readonly TopUp[]
  activations: readonly ActivationRecord[]
  schedules: readonly ScheduleRecord[]
  stakes: readonly WorkerStake[]
  backerWorkers?: readonly BackerWorkerInput[]
}

const addAmount = (amounts: Map<Address, bigint>, account: Address, amount: bigint) =>
  amounts.set(account, (amounts.get(account) ?? 0n) + amount)

function creditRecord(fee: FeeCharged, input: EpochInputV2): V2FeeRecord {
  const price = input.prices.tokens.find((token) => token.token === fee.token)
  if (price === undefined) return { fee, status: 'unpriced', usd: 0n, credit: null }
  const owed = treasuryOwed(fee, input.owed)
  if (
    owed !== undefined &&
    !input.withdrawals.some(
      (w) => w.holding === owed.holding && w.to === owed.to && w.token === owed.token && chainOrder(w, owed) > 0,
    )
  )
    return { fee, status: 'owed-to-treasury', usd: 0n, credit: null }
  const activation = input.activations
    .filter((a) => a.holding === fee.holding && a.jobId === fee.jobId && chainOrder(a, fee) < 0)
    .toSorted(chainOrder)
    .at(-1)
  if (activation === undefined) throw new Error('missing activation for counted fee')
  const stake = input.stakes.find((s) => s.worker === fee.worker)
  if (stake === undefined) throw new Error('missing worker stake endpoints for counted fee')
  const topUp = (input.topUps ?? [])
    .filter((t) => t.holding === fee.holding && t.jobId === fee.jobId && chainOrder(t, fee) < 0)
    .toSorted(chainOrder)
    .at(-1)
  const credit = creditOf({
    fee,
    activation,
    bonus: topUp?.bonus ?? 0n,
    schedule: scheduleAt(input.schedules, activation),
    heldStake: stake.start < stake.end ? stake.start : stake.end,
  })
  return { fee, status: 'counted', usd: (credit.credit * price.usdPrice) / 10n ** BigInt(price.decimals), credit }
}

function roleWeights(fees: readonly V2FeeRecord[], topUps: readonly TopUp[]) {
  const workers = new Map<Address, bigint>()
  const creators = new Map<Address, bigint>()
  for (const record of fees) {
    if (record.usd === 0n) continue
    addAmount(workers, record.fee.worker, record.usd)
    for (const { account, usd } of creatorWeights(record.fee, record.usd, topUps)) addAmount(creators, account, usd)
  }
  return { workers, creators }
}

/** Per-payment dust and rounding remain with the worker; final leaf dust remains in the reserve. */
function applyBackerSplits(
  amounts: Map<Address, bigint>,
  workerAmounts: ReadonlyMap<Address, bigint>,
  workers: readonly BackerWorkerInput[],
) {
  const positions: BackerPositionInput[] = []
  for (const worker of workers) {
    if (worker.bps <= 0n || worker.bps > 10000n) continue
    const weighted = worker.positions.filter((position) => position.weight >= V2_RULE.minBackerWeight)
    positions.push(...weighted)
    const totalWeight = weighted.reduce((sum, position) => sum + position.weight, 0n)
    if (totalWeight === 0n) continue
    const backerCut = ((workerAmounts.get(worker.worker) ?? 0n) * worker.bps) / 10000n
    let paid = 0n
    for (const position of weighted) {
      const payment = (backerCut * position.weight) / totalWeight
      if (payment < V2_RULE.minLeaf) continue
      paid += payment
      addAmount(amounts, position.delegator, payment)
    }
    addAmount(amounts, worker.worker, -paid)
  }
  return positions.toSorted((a, b) =>
    a.account === b.account
      ? a.delegator < b.delegator
        ? -1
        : a.delegator > b.delegator
          ? 1
          : 0
      : a.account < b.account
        ? -1
        : 1,
  )
}

export function computeEpochV2(input: EpochInputV2): EpochResultV2 {
  const fees = input.fees.map((fee) => creditRecord(fee, input))
  const creditUsd = fees.reduce((sum, record) => sum + record.usd, 0n)
  const factoryUsdPrice =
    input.prices.factoryUsdPrice > MIN_SIDE_USD_PRICE ? input.prices.factoryUsdPrice : MIN_SIDE_USD_PRICE
  const demand = (creditUsd * 10n ** 18n) / (2n * factoryUsdPrice)
  const emission = demand < input.budget ? demand : input.budget
  const amounts = new Map<Address, bigint>()
  const workerAmounts = new Map<Address, bigint>()
  const weights = roleWeights(fees, input.topUps ?? [])
  if (creditUsd > 0n) {
    const workerPool = (emission * V2_RULE.workerPercent) / 100n
    const creatorPool = (emission * V2_RULE.creatorPercent) / 100n
    for (const [account, usd] of weights.workers) {
      const amount = (workerPool * usd) / creditUsd
      workerAmounts.set(account, amount)
      addAmount(amounts, account, amount)
    }
    for (const [account, usd] of weights.creators) addAmount(amounts, account, (creatorPool * usd) / creditUsd)
  }
  const backerPositions = applyBackerSplits(amounts, workerAmounts, input.backerWorkers ?? [])
  const leaves = [...amounts]
    .filter(([, amount]) => amount >= V2_RULE.minLeaf)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([account, amount]) => ({ account, amount }))
  return {
    fees,
    feeUsd: creditUsd,
    creditUsd,
    factoryUsdPrice,
    demand,
    emission,
    leaves,
    backerPositions,
    total: leaves.reduce((sum, leaf) => sum + leaf.amount, 0n),
  }
}
