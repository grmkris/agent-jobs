/** Kind-specific v1 preparation. Chain facts remain authoritative; the board supplies unsigned calls only. */
import * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex, encodeFunctionData, getAddress, zeroAddress } from 'viem'
import { type EvaluatorWindows, type OfferTerms, listingMatches } from './terms.ts'

export const isHireling = (ctx: sdk.Ctx) => ctx.stack.kind === 'hireling-v1'
export const holdingAbi = (ctx: sdk.Ctx) => isHireling(ctx) ? sdk.hirelingHoldingAbi : sdk.jobHoldingAbi
export const evaluatorAbi = (ctx: sdk.Ctx) => isHireling(ctx) ? sdk.hirelingEvaluatorAbi : sdk.jobsEvaluatorAbi

export function rulingNonceUsed(ctx: sdk.Ctx, arbitrator: Address, nonce: bigint) {
  return isHireling(ctx)
    ? ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.hirelingEvaluatorAbi, functionName: 'rulingNonceUsed', args: [arbitrator, nonce] })
    : ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'rulingNonceUsed', args: [nonce] })
}

export async function offerWindows(ctx: sdk.Ctx, input?: EvaluatorWindows): Promise<EvaluatorWindows> {
  if (isHireling(ctx)) return input ?? { reviewSeconds: 86400, disputeSeconds: 86400, arbitrationSeconds: 172800 }
  const [reviewSeconds, disputeSeconds, arbitrationSeconds] = await Promise.all([
    ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'reviewWindow' }),
    ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'disputeWindow' }),
    ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'arbitrationWindow' }),
  ])
  return input ?? { reviewSeconds, disputeSeconds, arbitrationSeconds }
}

export async function offerArbitrator(ctx: sdk.Ctx, requested?: string): Promise<Address | undefined> {
  if (!isHireling(ctx)) return undefined
  return requested === undefined
    ? ctx.publicClient.readContract({ address: ctx.stack.holding, abi: sdk.hirelingHoldingAbi, functionName: 'defaultArbitrator' })
    : getAddress(requested)
}

export function transaction(ctx: sdk.Ctx, description: string, to: Address, data: Hex, gas?: bigint): sdk.TxRequest {
  return { description, chainId: ctx.deployment.chainId, to, data, value: '0', ...(gas === undefined ? {} : { gas: gas.toString() }) }
}

export async function publishHireling(ctx: sdk.Ctx, terms: OfferTerms, hash: Hex): Promise<sdk.TxRequest[]> {
  if (terms.arbitrator === undefined || terms.arbitrator.toLowerCase() === zeroAddress) throw new Error('v1 publish needs an explicit arbitrator')
  await sdk.requireStake(ctx, terms.creator, terms.creatorBond)
  const windows = { reviewWindow: terms.windows.reviewSeconds, disputeWindow: terms.windows.disputeSeconds, arbitrationWindow: terms.windows.arbitrationSeconds }
  const expiredAt = await sdk.minExpiry(ctx, terms.deliveryDeadline, windows)
  const allowance = await ctx.publicClient.readContract({ address: terms.token, abi: sdk.factoryTokenAbi, functionName: 'allowance', args: [terms.creator, ctx.stack.holding] })
  const out: sdk.TxRequest[] = []
  if (allowance < terms.reward) out.push(transaction(ctx, 'Approve the escrowed reward', terms.token,
    encodeFunctionData({ abi: sdk.factoryTokenAbi, functionName: 'approve', args: [ctx.stack.holding, terms.reward] })))
  out.push(transaction(ctx, 'Publish the funded hire and reserve your bond from stake', ctx.stack.holding,
    encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'publish', args: [{
      approver: terms.approver, arbitrator: terms.arbitrator, manifestHash: hash, policyHash: hash,
      token: terms.token, reward: terms.reward, creatorBond: terms.creatorBond, workerBond: terms.workerBond,
      deliveryDeadline: terms.deliveryDeadline, expiredAt, ...windows,
    }] })))
  return out
}

export function acceptedActivationTerms(terms: OfferTerms): sdk.ActivationTerms {
  if (terms.arbitrator === undefined) throw new Error('v1 offer has no frozen arbitrator')
  return { creator: terms.creator, approver: terms.approver, token: terms.token, reward: terms.reward,
    creatorBond: terms.creatorBond, workerBond: terms.workerBond, arbitrator: terms.arbitrator, deliveryDeadline: terms.deliveryDeadline,
    reviewWindow: terms.windows.reviewSeconds, disputeWindow: terms.windows.disputeSeconds, arbitrationWindow: terms.windows.arbitrationSeconds }
}

export function matchesHireling(terms: OfferTerms, hash: Hex, listing: Awaited<ReturnType<typeof sdk.getV1Listing>>): boolean {
  try { sdk.assertActivationTerms(listing, acceptedActivationTerms(terms)) } catch { return false }
  return listingMatches(terms, hash, { ...listing, mode: 0, selectionDeadline: 0 })
}

export async function activationQuote(ctx: sdk.Ctx, jobId: bigint, worker: Address, terms: OfferTerms) {
  sdk.assertActivationTerms(await sdk.getV1Listing(ctx, jobId), acceptedActivationTerms(terms))
  await sdk.requireStake(ctx, worker, terms.workerBond)
  const [feeBps, fee, net] = await sdk.quoteActivation(ctx, jobId, worker)
  return { feeBps, fee, net }
}

export async function hirelingChainView(ctx: sdk.Ctx, jobId: bigint, offer: OfferTerms, hash: Hex, now: number) {
  const state = await sdk.hirelingState(ctx, jobId)
  const { job, listing, decision, terms } = state
  const status = job.statusName === 'Open' ? now > terms.deliveryDeadline ? 'lapsed' : 'open'
    : job.statusName === 'Rejected' && job.provider === zeroAddress ? 'cancelled' : state.status
  return { status, coreStatus: job.statusName, listingMatchesOffer: matchesHireling(offer, hash, listing),
    provider: job.provider === zeroAddress ? null : job.provider, submittedAt: job.submittedAt === 0 ? null : job.submittedAt,
    timely: job.submittedAt > 0 && job.submittedAt <= terms.deliveryDeadline, deliveryDeadline: terms.deliveryDeadline,
    reviewEndsAt: state.reviewEndsAt, disputeEndsAt: state.disputeEndsAt, arbitrationEndsAt: state.arbitrationEndsAt,
    violation: decision.rejectedAt === 0 ? null : (['None', 'Quality', 'Falsified'][decision.violation] ?? null),
    outcome: state.outcome, deferredDecision: state.deferredDecision, collectPending: state.collectPending,
    feeBps: listing.feeBps, fee: listing.fee.toString(), net: terms.funded.toString(), bonus: listing.bonus.toString(), paused: state.paused,
  }
}

export async function settleHireling(ctx: sdk.Ctx, jobId: bigint, wallet: Address | undefined, now: number): Promise<sdk.TxRequest[]> {
  const state = await sdk.hirelingState(ctx, jobId)
  const out: sdk.TxRequest[] = []
  const terminal = ['Completed', 'Rejected', 'Expired'].includes(state.job.statusName)
  const settle = () => transaction(ctx, 'Settle the agreed reward, fee, bonus and bonds', ctx.stack.holding,
    encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'settle', args: [jobId] }), sdk.V1_GAS.settle)
  if (!state.paused && state.deferredDecision) out.push(...sdk.deferredCollectTransactions(ctx, jobId))
  else if (terminal && state.collectPending) out.push(settle())
  else if (!terminal && !state.paused) {
    let fn: 'completeAfterSilence' | 'rejectAfterWindow' | 'refundAfterArbitrationTimeout' | 'rejectAfterDeliveryDeadline' | undefined
    if (state.status === 'disputed' && state.arbitrationEndsAt !== null && now > state.arbitrationEndsAt) fn = 'refundAfterArbitrationTimeout'
    else if (state.status === 'rejected-pending' && state.disputeEndsAt !== null && now > state.disputeEndsAt) fn = 'rejectAfterWindow'
    else if (state.status === 'submitted' && state.job.submittedAt <= state.terms.deliveryDeadline && state.reviewEndsAt !== null && now > state.reviewEndsAt) fn = 'completeAfterSilence'
    else if ((state.status === 'active' || (state.status === 'submitted' && state.job.submittedAt > state.terms.deliveryDeadline)) && now > state.terms.deliveryDeadline) fn = 'rejectAfterDeliveryDeadline'
    if (fn !== undefined) out.push(transaction(ctx, 'Finalize the elapsed window', ctx.stack.evaluator,
      encodeFunctionData({ abi: sdk.hirelingEvaluatorAbi, functionName: fn, args: [jobId] }), sdk.V1_GAS.evaluator), settle())
  }
  if (wallet !== undefined) {
    const [owed, topUp] = await Promise.all([
      ctx.publicClient.readContract({ address: ctx.stack.holding, abi: sdk.hirelingHoldingAbi, functionName: 'owed', args: [state.listing.token, wallet] }),
      ctx.publicClient.readContract({ address: ctx.stack.holding, abi: sdk.hirelingHoldingAbi, functionName: 'topUpOf', args: [jobId, wallet] }),
    ])
    if (topUp > 0n && state.listing.outcome === 2) out.push(sdk.topUpRefundTransaction(ctx, jobId, wallet))
    if (owed > 0n) out.push(transaction(ctx, 'Withdraw your refused token payout', ctx.stack.holding,
      encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'withdraw', args: [state.listing.token] })))
  }
  return out
}
