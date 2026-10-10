import type { BackerPositionInput } from './compute.ts'
import type { V2FeeRecord, WorkerStake } from './compute-v2.ts'
import { chainOrder, type ScheduleRecord } from './credit.ts'
import { lower } from './ledger-chain.ts'
import { V2_RULE } from './rule.ts'
import type { verifiedPriceList } from './prices.ts'
import type { budgetOf } from './chain.ts'
import type { Address, Hex } from './viem.ts'

export interface CanonicalWindow {
  start: string
  end: string
  fromBlock: string
  toBlock: string
  toBlockHash: Hex
}
export interface CanonicalShareWindow {
  start: string
  block: string
}
export interface WalletBackerShare {
  worker: Address
  bps: bigint
  agentIds: bigint[]
  source: { agentId: bigint; block: bigint; logIndex: number; tx?: Hex } | null
}
type ScheduleWithTx = ScheduleRecord & { tx?: Hex }
const id = (value: { block: bigint; logIndex: number }) => `${value.block}:${value.logIndex}`
const txOf = (value: { tx?: Hex }): Hex => {
  if (value.tx === undefined) throw new Error('missing transaction in canonical v2 history')
  // SAFETY: ABI-decoded hex retains its shape after case normalization.
  return value.tx.toLowerCase() as Hex
}
const event = (value: { block: bigint; logIndex: number; tx?: Hex }) => ({
  block: value.block.toString(),
  logIndex: value.logIndex,
  tx: txOf(value),
})
const addressOrder = (a: Address, b: Address) => (a < b ? -1 : a > b ? 1 : 0)
const positionOrder = (a: BackerPositionInput, b: BackerPositionInput) =>
  addressOrder(a.account, b.account) || addressOrder(a.delegator, b.delegator)

function canonicalFee(record: V2FeeRecord) {
  const f = record.fee
  const base = {
    ...event(f),
    holding: lower(f.holding),
    jobId: f.jobId.toString(),
    token: lower(f.token),
    worker: lower(f.worker),
    creator: lower(f.creator),
    amount: f.amount.toString(),
    bonusPart: f.bonusPart.toString(),
    status: record.status,
    usd: record.usd.toString(),
  }
  const c = record.credit
  if (c === null) return { ...base, credit: null }
  return {
    ...base,
    credit: {
      activation: event(c.activation),
      agentId: c.agentId.toString(),
      feeBps: c.feeBps.toString(),
      fee: c.activation.fee.toString(),
      net: c.activation.net.toString(),
      bonus: c.bonus.toString(),
      gross: c.gross.toString(),
      schedule: id(c.schedule),
      floorBps: c.lowestBps.toString(),
      tier: { activation: c.activationRank, backing: c.heldRank },
      boost: c.boostBps.toString(),
      amount: c.credit.toString(),
      usd: c.usd.toString(),
    },
  }
}

export function canonicalRuleV2(
  fromEpoch: bigint,
  unstakeDelay: bigint,
  peggedOnly: boolean,
  pegged: readonly Address[],
) {
  return {
    version: 2,
    fromEpoch: fromEpoch.toString(),
    payoutBps: V2_RULE.payoutBps.toString(),
    workerPercent: V2_RULE.workerPercent.toString(),
    creatorPercent: V2_RULE.creatorPercent.toString(),
    boostBps: V2_RULE.boostBps.map(String),
    minBackerWeight: V2_RULE.minBackerWeight.toString(),
    minLeaf: V2_RULE.minLeaf.toString(),
    unstakeDelay: unstakeDelay.toString(),
    prices: {
      factoryAtFactoryPrice: true,
      peggedOnly,
      pegTolerance: V2_RULE.pegToleranceWei.toString(),
      pegged: pegged.map(lower).toSorted(),
    },
  }
}

/** Signed arrays cannot be reordered after signing; require their canonical order at the boundary. */
export function checkCanonicalPriceTokens(tokens: readonly { token: string }[]): void {
  if (tokens.some((token, i) => i > 0 && (tokens[i - 1]?.token ?? '') >= token.token))
    throw new Error('v2 signed price tokens must be in address order')
}

const canonicalSchedule = (schedule: ScheduleWithTx) => ({
  id: id(schedule),
  ...event(schedule),
  thresholds: schedule.thresholds.map(String),
  bps: schedule.bps.map(String),
  treasury: lower(schedule.treasury),
})
const canonicalPosition = (position: BackerPositionInput) => ({
  account: lower(position.account),
  delegator: lower(position.delegator),
  start: position.start.toString(),
  end: position.end.toString(),
  weight: position.weight.toString(),
})
const canonicalShare = (share: WalletBackerShare) => ({
  worker: lower(share.worker),
  bps: share.bps.toString(),
  agentIds: share.agentIds.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(String),
  source: share.source === null ? null : { agentId: share.source.agentId.toString(), ...event(share.source) },
})

export interface InputsV2Args {
  chainId: number
  epoch: bigint
  rule: ReturnType<typeof canonicalRuleV2>
  window: CanonicalWindow
  shareWindow: CanonicalShareWindow
  holdings: readonly Address[]
  priceList: unknown
  factoryPriceEvidence: unknown
  budget: unknown
  feeSchedules: readonly ScheduleWithTx[]
  fees: readonly V2FeeRecord[]
  topUps: readonly {
    block: bigint
    logIndex: number
    tx?: Hex
    holding: Address
    jobId: bigint
    contributor: Address
    amount: bigint
    bonus: bigint
  }[]
  backing: readonly WorkerStake[]
  backerShares: readonly WalletBackerShare[]
  backerPositions: readonly BackerPositionInput[]
  checkpoint?: { previous: { epoch: string; dataHash: Hex; stateHash: Hex } | null; stateHash: Hex }
}

/** Fixed key order. A checkpoint slot can be appended by M3 without including finalized-head state. */
export function inputsV2Of(args: InputsV2Args) {
  return {
    chainId: args.chainId,
    epoch: args.epoch.toString(),
    rule: args.rule,
    window: args.window,
    shareWindow: args.shareWindow,
    holdings: args.holdings.map(lower).toSorted(),
    priceList: args.priceList,
    factoryPriceEvidence: args.factoryPriceEvidence,
    budget: args.budget,
    feeSchedules: args.feeSchedules.toSorted(chainOrder).map(canonicalSchedule),
    fees: args.fees.toSorted((a, b) => chainOrder(a.fee, b.fee)).map(canonicalFee),
    topUps: args.topUps.toSorted(chainOrder).map((topUp) => ({
      ...event(topUp),
      holding: lower(topUp.holding),
      jobId: topUp.jobId.toString(),
      contributor: lower(topUp.contributor),
      amount: topUp.amount.toString(),
      bonus: topUp.bonus.toString(),
    })),
    backing: args.backing
      .toSorted((a, b) => addressOrder(a.worker, b.worker))
      .map((stake) => ({
        worker: lower(stake.worker),
        stakeStart: stake.start.toString(),
        stakeEnd: stake.end.toString(),
      })),
    backerShares: args.backerShares.toSorted((a, b) => addressOrder(a.worker, b.worker)).map(canonicalShare),
    backerPositions: args.backerPositions.toSorted(positionOrder).map(canonicalPosition),
    ...(args.checkpoint === undefined ? {} : { checkpoint: args.checkpoint }),
  }
}

export const priceListOf = ({ prices, signer, signature }: Awaited<ReturnType<typeof verifiedPriceList>>) => ({
  message: {
    epoch: String(prices.epoch),
    tokens: prices.tokens.map((t) => ({ token: t.token, decimals: t.decimals, usdPrice: String(t.usdPrice) })),
    factoryUsdPrice: String(prices.factoryUsdPrice),
  },
  signer,
  signature,
})

export const canonicalBudget = (budget: Awaited<ReturnType<typeof budgetOf>>) => ({
  cumulativeBudget: String(budget.cumulativeBudget),
  fundedBefore: String(budget.fundedBefore),
  available: String(budget.available),
  usable: budget.usable.map((lot) => ({
    epoch: String(lot.epoch),
    scheduled: String(lot.scheduled),
    remaining: String(lot.remaining),
  })),
  expired: budget.expired.map((lot) => ({
    epoch: String(lot.epoch),
    scheduled: String(lot.scheduled),
    remaining: String(lot.remaining),
  })),
})
