/** Discovery comes from a checked index; every claim and amount below is re-read from the chain. */
import * as sdk from '@agent-jobs/sdk'
import { type Address, encodeFunctionData, zeroAddress } from 'viem'
import { holdingAbi, settleHireling, transaction } from './hireling.ts'
import { miningProof, type MiningSource } from './mining.ts'

export interface CollectSnapshot {
  jobs: Array<{ jobId: string; holding: string }>
  tokens: Array<{ holding: string; token: string }>
  epochs?: string[]
}
export interface CollectAction {
  kind: 'settle' | 'claimTopUpRefund' | 'withdraw' | 'claimRefund' | 'stakeWithdraw' | 'miningClaim'
  jobId?: string | null
  epoch?: string | null
  token?: string | null
  amount?: string | null
  description: string
  transactions: sdk.TxRequest[]
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

async function legacySettlement(ctx: sdk.Ctx, jobId: bigint, now: number): Promise<sdk.TxRequest[]> {
  const [job, listing, paused, rejectedAt, disputedAt, review, dispute, arbitration] = await Promise.all([
    sdk.getJob(ctx, jobId), sdk.getListing(ctx, jobId), ctx.publicClient.readContract({ address: ctx.deployment.core, abi: sdk.coreAbi, functionName: 'paused' }),
    ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'rejectedAt', args: [jobId] }),
    ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'disputedAt', args: [jobId] }),
    ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'reviewWindow' }),
    ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'disputeWindow' }),
    ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'arbitrationWindow' }),
  ])
  const settle = transaction(ctx, 'Settle the legacy reward and bonds', ctx.stack.holding, encodeFunctionData({ abi: sdk.jobHoldingAbi, functionName: 'settle', args: [jobId] }), sdk.V1_GAS.settle)
  const terminal = ['Completed', 'Rejected', 'Expired'].includes(job.statusName)
  if (terminal) {
    const rewardHere = ['Rejected', 'Expired'].includes(job.statusName)
    return (!listing.creatorBondSettled || listing.workerBondPosted && !listing.workerBondSettled || rewardHere && !listing.rewardSettled) ? [settle] : []
  }
  if (paused) return []
  if (listing.mode === 1 && listing.worker === zeroAddress && now > listing.selectionDeadline) return [transaction(ctx, 'Expire the unawarded legacy contest', ctx.stack.holding, encodeFunctionData({ abi: sdk.jobHoldingAbi, functionName: 'expireContest', args: [jobId] })), settle]
  let fn: 'completeAfterSilence' | 'rejectAfterWindow' | 'refundAfterArbitrationTimeout' | 'rejectAfterDeliveryDeadline' | undefined
  if (disputedAt > 0 && now > disputedAt + arbitration) fn = 'refundAfterArbitrationTimeout'
  else if (rejectedAt > 0 && disputedAt === 0 && now > rejectedAt + dispute) fn = 'rejectAfterWindow'
  else if (job.statusName === 'Submitted' && rejectedAt === 0 && job.submittedAt <= listing.deliveryDeadline && now > job.submittedAt + review) fn = 'completeAfterSilence'
  else if ((job.statusName === 'Funded' || job.statusName === 'Submitted' && job.submittedAt > listing.deliveryDeadline) && now > listing.deliveryDeadline) fn = 'rejectAfterDeliveryDeadline'
  return fn === undefined ? [] : [transaction(ctx, 'Finalize the elapsed legacy window', ctx.stack.evaluator, encodeFunctionData({ abi: sdk.jobsEvaluatorAbi, functionName: fn, args: [jobId] })), ...(fn === 'completeAfterSilence' ? [] : [settle])]
}

export async function collectActions(base: sdk.Ctx, wallet: Address, snapshot: CollectSnapshot, mining?: MiningSource): Promise<CollectAction[]> {
  const now = Number((await base.publicClient.getBlock()).timestamp)
  const out: CollectAction[] = [], tokens = new Map<string, { ctx: sdk.Ctx; token: Address }>()
  const pair = (holding: string): sdk.Ctx => {
    const entry = sdk.stackByHolding(base.deployment, holding)
    if (entry === undefined) throw new Error('the collect index references an unknown Holding')
    return { ...base, stack: entry[1] }
  }
  const addToken = (ctx: sdk.Ctx, token: Address) => tokens.set(`${ctx.stack.holding.toLowerCase()}:${token.toLowerCase()}`, { ctx, token })
  for (const t of snapshot.tokens) addToken(pair(t.holding), t.token as Address)
  const jobs = new Set<string>()
  for (const candidate of snapshot.jobs) {
    if (jobs.has(candidate.jobId)) continue
    jobs.add(candidate.jobId)
    const ctx = pair(candidate.holding), jobId = BigInt(candidate.jobId)
    const [job, listing] = await Promise.all([sdk.getJob(ctx, jobId), sdk.getListing(ctx, jobId)])
    if (!same(job.client, ctx.stack.holding)) throw new Error('the collect index does not match the canonical job Holding')
    if (ctx.stack.openTokens) addToken(ctx, listing.token)
    const contribution = ctx.stack.kind === 'hireling-v1'
      ? await ctx.publicClient.readContract({ address: ctx.stack.holding, abi: sdk.hirelingHoldingAbi, functionName: 'topUpOf', args: [jobId, wallet] }) : 0n
    const party = [listing.creator, listing.approver, listing.worker].some(a => same(a, wallet))
    if (party || contribution > 0n) {
      const transactions = ctx.stack.kind === 'hireling-v1' ? await settleHireling(ctx, jobId, undefined, now) : await legacySettlement(ctx, jobId, now)
      if (transactions.length > 0) out.push({ kind: 'settle', jobId: candidate.jobId, description: 'Finalize and settle this job under its agreed outcome.', transactions })
      else if (['Open', 'Funded', 'Submitted'].includes(job.statusName) && now >= job.expiredAt) {
        // The core's own claim cutoff and pending-claim restrictions remain authoritative.
        const paused = await ctx.publicClient.readContract({ address: ctx.deployment.core, abi: sdk.coreAbi, functionName: 'paused' })
        const grace = job.statusName === 'Submitted' ? Number(await ctx.publicClient.readContract({ address: ctx.deployment.core, abi: sdk.coreAbi, functionName: 'EVALUATION_GRACE_PERIOD' })) : 0
        const pending = await ctx.publicClient.readContract({ address: ctx.deployment.core, abi: sdk.coreAbi, functionName: 'pendingClaimHash', args: [jobId] })
        if (!paused && now >= job.expiredAt + grace && (job.statusName === 'Submitted' || /^0x0+$/.test(pending))) out.push({ kind: 'claimRefund', jobId: candidate.jobId,
          description: 'Claim the expired core refund and settle the agreed payment rights.', transactions: [
            transaction(ctx, 'Claim the expired core refund', ctx.deployment.core, encodeFunctionData({ abi: sdk.coreAbi, functionName: 'claimRefund', args: [jobId] })),
            transaction(ctx, 'Settle the agreed reward and bonds', ctx.stack.holding, encodeFunctionData({ abi: holdingAbi(ctx), functionName: 'settle', args: [jobId] }), sdk.V1_GAS.settle),
          ] })
      }
    }
    if (ctx.stack.kind === 'hireling-v1') {
      const v1 = await sdk.getV1Listing(ctx, jobId)
      if (v1.outcome === 2 && contribution > 0n) out.push({ kind: 'claimTopUpRefund', jobId: candidate.jobId, token: listing.token, amount: contribution.toString(), description: 'Collect your contribution to this refunded job.', transactions: [sdk.topUpRefundTransaction(ctx, jobId, wallet)] })
    }
  }
  for (const { ctx, token } of tokens.values()) {
    const owed = await ctx.publicClient.readContract({ address: ctx.stack.holding, abi: holdingAbi(ctx), functionName: 'owed', args: [token, wallet] })
    if (owed > 0n) out.push({ kind: 'withdraw', token, amount: owed.toString(), description: 'Withdraw the token payment held for your wallet.', transactions: [transaction(ctx, 'Withdraw the refused token payout', ctx.stack.holding, encodeFunctionData({ abi: holdingAbi(ctx), functionName: 'withdraw', args: [token] }), 450_000n)] })
  }
  if (base.deployment.hireling !== null) {
    const h = base.deployment.hireling, state = await sdk.getStake(base, wallet)
    if (state.unstaking > 0n && now >= state.unlockAt) out.push({ kind: 'stakeWithdraw', token: h.factory, amount: state.unstaking.toString(), description: 'Withdraw FACTORY whose unstaking cooldown has ended.', transactions: [transaction(base, 'Withdraw unstaked FACTORY', h.vault, encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'withdraw' }))] })
    for (const epoch of new Set(snapshot.epochs ?? [])) {
      if (mining === undefined) throw new Error('mining artifacts are unavailable for Collect')
      const claim = await miningProof(base, wallet, epoch, mining)
      if (claim.transactions.length > 0) out.push({ kind: 'miningClaim', epoch, token: claim.token, amount: claim.amount,
        description: 'Claim work mining into your FACTORY stake.', transactions: claim.transactions })
    }
  }
  return out
}
