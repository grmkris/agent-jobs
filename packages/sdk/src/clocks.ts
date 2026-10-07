/** D24: immutables are authoritative on chain; synchronous consumers use the promoted config. */
import { feeScheduleAbi, sidequestHoldingAbi, miningReserveAbi, stakeVaultAbi } from './abi/index.ts'
import type { Ctx } from './actions.ts'
import {
  clocksFromConfig,
  MAX_SIDEQUEST_WINDOW,
  PRODUCTION_CLOCKS,
  type Deployment,
  type SidequestClocks,
} from './deployment.ts'

export interface OfferWindows {
  reviewSeconds: number
  disputeSeconds: number
  arbitrationSeconds: number
}
export interface WindowBounds {
  review: { min: number; max: number }
  dispute: { min: number; max: number }
  arbitration: { min: number; max: number }
}

export const configuredClocks = (d: Pick<Deployment, 'sidequest' | 'chainId'>): SidequestClocks =>
  clocksFromConfig(d.sidequest?.clocks, d.chainId)
export function windowBounds(clocks: SidequestClocks = PRODUCTION_CLOCKS): WindowBounds {
  return {
    review: { min: clocks.minReviewWindow, max: MAX_SIDEQUEST_WINDOW },
    dispute: { min: clocks.minDisputeWindow, max: MAX_SIDEQUEST_WINDOW },
    arbitration: { min: clocks.minArbitrationWindow, max: MAX_SIDEQUEST_WINDOW },
  }
}

function duration(seconds: number) {
  for (const [unit, length] of [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ] as const)
    if (seconds % length === 0) return `${seconds / length} ${unit}${seconds / length === 1 ? '' : 's'}`
  return `${seconds} seconds`
}
export function validateOfferWindows(windows: OfferWindows, bounds: WindowBounds = windowBounds()): void {
  for (const [field, key] of [
    ['reviewSeconds', 'review'],
    ['disputeSeconds', 'dispute'],
    ['arbitrationSeconds', 'arbitration'],
  ] as const) {
    const { min, max } = bounds[key],
      value = windows[field]
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${key} window must be between ${duration(min)} and ${duration(max)}`)
  }
}

const boundsCache = new WeakMap<Ctx, Promise<WindowBounds>>()
/** Cache only successful immutable reads. RPC errors stay unavailable and are retriable. */
export function readWindowBounds(ctx: Ctx): Promise<WindowBounds> {
  if (ctx.stack.kind !== 'sidequest-v1') return Promise.reject(new Error('Window bounds require sidequest-v1'))
  const saved = boundsCache.get(ctx)
  if (saved !== undefined) return saved
  const pending = (async () => {
    const values = await Promise.all(
      (
        [
          'MIN_REVIEW_WINDOW',
          'MAX_REVIEW_WINDOW',
          'MIN_DISPUTE_WINDOW',
          'MAX_DISPUTE_WINDOW',
          'MIN_ARBITRATION_WINDOW',
          'MAX_ARBITRATION_WINDOW',
        ] as const
      ).map((functionName) =>
        ctx.publicClient.readContract({ address: ctx.stack.holding, abi: sidequestHoldingAbi, functionName }),
      ),
    )
    const [reviewMin, reviewMax, disputeMin, disputeMax, arbitrationMin, arbitrationMax] = values.map(Number)
    const bounds: WindowBounds = {
      review: { min: reviewMin!, max: reviewMax! },
      dispute: { min: disputeMin!, max: disputeMax! },
      arbitration: { min: arbitrationMin!, max: arbitrationMax! },
    }
    for (const bound of Object.values(bounds))
      if (
        !Number.isSafeInteger(bound.min) ||
        !Number.isSafeInteger(bound.max) ||
        bound.min <= 0 ||
        bound.min > bound.max ||
        bound.max !== MAX_SIDEQUEST_WINDOW
      )
        throw new Error('Invalid deployed window bounds')
    return bounds
  })()
  boundsCache.set(ctx, pending)
  void pending.catch(() => boundsCache.delete(ctx))
  return pending
}

const clocksCache = new WeakMap<Ctx, Promise<SidequestClocks>>()
export function readSidequestClocks(ctx: Ctx): Promise<SidequestClocks> {
  const h = ctx.deployment.sidequest
  if (ctx.stack.kind !== 'sidequest-v1' || h === null)
    return Promise.reject(new Error('Protocol clocks require sidequest-v1'))
  const saved = clocksCache.get(ctx)
  if (saved !== undefined) return saved
  const pending = (async () => {
    const [bounds, unstakeDelay, holdingDelay, vaultGrace, feeDelay, feeGrace, epochZeroDuration, epochDuration] =
      await Promise.all([
        readWindowBounds(ctx),
        ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'UNSTAKE_DELAY' }),
        ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'HOLDING_DELAY' }),
        ctx.publicClient.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'PROPOSAL_GRACE' }),
        ctx.publicClient.readContract({ address: h.feeSchedule, abi: feeScheduleAbi, functionName: 'DELAY' }),
        ctx.publicClient.readContract({ address: h.feeSchedule, abi: feeScheduleAbi, functionName: 'PROPOSAL_GRACE' }),
        ctx.publicClient.readContract({
          address: h.miningReserve,
          abi: miningReserveAbi,
          functionName: 'EPOCH_ZERO_DURATION',
        }),
        ctx.publicClient.readContract({
          address: h.miningReserve,
          abi: miningReserveAbi,
          functionName: 'EPOCH_DURATION',
        }),
      ])
    if (vaultGrace !== feeGrace) throw new Error('Deployed proposal grace clocks disagree')
    return clocksFromConfig(
      {
        minReviewWindow: bounds.review.min,
        minDisputeWindow: bounds.dispute.min,
        minArbitrationWindow: bounds.arbitration.min,
        unstakeDelay: Number(unstakeDelay),
        holdingDelay: Number(holdingDelay),
        feeDelay: Number(feeDelay),
        proposalGrace: Number(vaultGrace),
        epochZeroDuration: Number(epochZeroDuration),
        epochDuration: Number(epochDuration),
      },
      ctx.deployment.chainId,
    )
  })()
  clocksCache.set(ctx, pending)
  void pending.catch(() => clocksCache.delete(ctx))
  return pending
}

export const minimumOfferWindows = (bounds: WindowBounds): OfferWindows => ({
  reviewSeconds: bounds.review.min,
  disputeSeconds: bounds.dispute.min,
  arbitrationSeconds: bounds.arbitration.min,
})

/** The Standard preference is 24h/24h/48h; preferences are clamped to deployed protocol bounds. */
const clamp = (value: number, bound: { min: number; max: number }) => Math.min(bound.max, Math.max(bound.min, value))
export function standardOfferWindows(bounds: WindowBounds): OfferWindows {
  return {
    reviewSeconds: clamp(86400, bounds.review),
    disputeSeconds: clamp(86400, bounds.dispute),
    arbitrationSeconds: clamp(172800, bounds.arbitration),
  }
}
