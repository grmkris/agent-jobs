/** Testnet live matrix money paths. Every send goes through the persisted journal; this module never deploys. */
import { type Address, decodeEventLog, encodeFunctionData, parseUnits } from 'viem'
import * as sdk from './index.ts'
import { FlowJournal } from './flow-journal.ts'

export const V1_CORE_FLOWS = ['hire', 'silence', 'ruling-worker', 'ruling-worker-slash', 'ruling-creator', 'ruling-creator-slash', 'violation', 'missed', 'cancel', 'arbitration-timeout', 'topup-paid', 'topup-refund', 'stake-cooldown', 'fees', 'legacy-contest', 'legacy-dispute'] as const
export type V1CoreFlow = typeof V1_CORE_FLOWS[number]
export interface V1FlowDeps {
  ctx: sdk.Ctx; journal: FlowJournal
  creator: sdk.Wallet; worker: sdk.Wallet; relay: sdk.Wallet; arbitrator: sdk.Wallet
  agentId: bigint; token: Address; reward: bigint; bond: bigint
  waitUntil: (label: string, timestamp: number) => Promise<void>
  log: (text: string) => void
  legacyArbitrator?: sdk.Wallet
  refusingToken?: { owner: sdk.Wallet; kind: 'blocklist' | 'gasBurner' }
}
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const check = (what: string, actual: bigint | number | string | boolean, expected: bigint | number | string | boolean) => { if (actual !== expected) throw new Error(`${what}: got ${String(actual)}, expected ${String(expected)}`) }

export async function runV1CoreFlow(d: V1FlowDeps, flow: V1CoreFlow, scope = flow as string) {
  const { ctx, creator, worker, relay, journal: j } = d, h = ctx.deployment.hireling
  if (ctx.deployment.chainId !== 10143 || await ctx.publicClient.getChainId() !== 10143 || ctx.stack.kind !== 'hireling-v1' || h === null) throw new Error('v1 flows require deployed Hireling on chain 10143')
  if (j.state.values[`${scope}/done`] === true) { d.log(`${scope}: already verified; no sends`); return }
  const now = async () => Number((await ctx.publicClient.getBlock()).timestamp)
  const call = (label: string, wallet: sdk.Wallet, target: Address, abi: readonly unknown[], fn: string, args: readonly unknown[], gas?: bigint) => j.contract(`${scope}/${label}`, wallet, target, abi as import('viem').Abi, fn, args, gas)
  const approve = async (label: string, wallet: sdk.Wallet, token: Address, spender: Address, amount: bigint) => {
    const needed = await j.once(`${scope}/${label}/needed`, async () => await ctx.publicClient.readContract({ address: token, abi: sdk.factoryTokenAbi, functionName: 'allowance', args: [wallet.account.address, spender] }) < amount)
    if (needed) await call(label, wallet, token, sdk.factoryTokenAbi, 'approve', [spender, amount])
  }
  const before = await j.once(`${scope}/before`, async () => ({ creatorReward: await sdk.balanceOf(ctx, d.token, creator.account.address), workerReward: await sdk.balanceOf(ctx, d.token, worker.account.address), creatorStake: (await sdk.getStake(ctx, creator.account.address)).staked, workerStake: (await sdk.getStake(ctx, worker.account.address)).staked }))
  let workerRewardBefore = before.workerReward
  const publish = async (pair = ctx) => {
    const p = await j.once(`${scope}/offer`, async () => {
      const t = await now(), deadline = t + (flow === 'missed' ? 120 : 6 * 3600)
      const windows = { reviewWindow: 3600, disputeWindow: 3600, arbitrationWindow: 43200 }
      return { token: d.token, reward: d.reward, creatorBond: flow.startsWith('legacy-') ? 0n : d.bond, workerBond: flow.startsWith('legacy-') ? 0n : d.bond,
        approver: creator.account.address, manifestHash: sdk.hashText(`v1 flow ${flow}`), policyHash: sdk.hashText(`${flow}:${t}:${sdk.randomNonce()}`),
        deliveryDeadline: deadline, expiredAt: await sdk.minExpiry(pair, deadline, windows), ...windows, arbitrator: d.arbitrator.account.address }
    })
    await approve('approve-reward', creator, p.token, pair.stack.holding, p.reward)
    const request = pair.stack.kind === 'hireling-v1' ? p : { approver: p.approver, manifestHash: p.manifestHash, policyHash: p.policyHash, token: p.token, reward: p.reward,
      creatorBond: 0n, workerBond: 0n, deliveryDeadline: p.deliveryDeadline, expiredAt: p.expiredAt, mode: flow === 'legacy-contest' ? 1 : 0, selectionDeadline: flow === 'legacy-contest' ? p.deliveryDeadline - 60 : 0 }
    const receipt = await call('publish', creator, pair.stack.holding, pair.stack.kind === 'hireling-v1' ? sdk.hirelingHoldingAbi : sdk.jobHoldingAbi, 'publish', [request])
    let jobId: bigint | undefined
    for (const log of receipt.logs) { if (!eq(log.address, pair.stack.holding)) continue
      try { const event = decodeEventLog({ abi: pair.stack.kind === 'hireling-v1' ? sdk.hirelingHoldingAbi : sdk.jobHoldingAbi, data: log.data, topics: log.topics }); if (event.eventName === 'Published') jobId = event.args.jobId } catch { /* Other logs. */ } }
    if (jobId === undefined) throw new Error(`${flow}: no canonical Published event`)
    j.state.values[`${scope}/jobId`] = jobId; j.save(j.state)
    return { p, jobId }
  }
  const activate = async (x: Awaited<ReturnType<typeof publish>>, pair = ctx) => {
    const selectionData = await j.once(`${scope}/selection`, async () => {
      const listing = await sdk.getListing(pair, x.jobId)
      if (pair.stack.kind === 'hireling-v1') sdk.assertActivationTerms(await sdk.getV1Listing(pair, x.jobId), { ...x.p, creator: creator.account.address })
      const selection = { jobId: x.jobId, worker: worker.account.address, agentId: d.agentId, termsHash: x.p.policyHash, activateBy: x.p.deliveryDeadline - 1, nonce: sdk.randomNonce() }
      const sig = await sdk.signSelection(pair, creator, selection)
      return { selection, sig, reward: listing.reward }
    })
    // An unsigned attempt may resume after the worker's stake changes. Requote immediately before signing;
    // once signed transaction bytes exist, resume only those bytes and their original authorization.
    const data = j.state.sends[`${scope}/activate`] === undefined ? await (async () => {
      const net = pair.stack.kind === 'hireling-v1' ? (await sdk.quoteActivation(pair, x.jobId, worker.account.address))[2] : selectionData.reward
      const auth = await sdk.signBudget(pair, worker, { jobId: x.jobId, token: x.p.token, amount: net, deadline: BigInt((await now()) + 3600) })
      const result = { ...selectionData, auth, net }; j.state.values[`${scope}/activation`] = result; j.save(j.state); return result
    })() : j.state.values[`${scope}/activation`] as typeof selectionData & { auth: sdk.Authorization; net: bigint }
    await call('activate', worker, pair.stack.holding, pair.stack.kind === 'hireling-v1' ? sdk.hirelingHoldingAbi : sdk.jobHoldingAbi, 'activate', [data.selection, data.sig, data.auth])
    const stakeState = await sdk.getStake(ctx, worker.account.address)
    if (pair.stack.kind === 'hireling-v1' && x.p.workerBond > 0n && j.state.values[`${scope}/reservation-refused`] !== true) {
      let refused = false
      try { await ctx.publicClient.estimateGas({ account: worker.account, to: h.vault,
        data: encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'requestUnstake', args: [stakeState.staked] }) }) } catch { refused = true }
      check('reservation prevents unstaking', refused, true)
      j.state.values[`${scope}/reservation-refused`] = true; j.save(j.state)
    }
    return data.net
  }
  const submit = (jobId: bigint) => call('submit', worker, ctx.deployment.core, sdk.coreAbi, 'submit', [jobId, sdk.hashText(`deliverable:${flow}`), '0x'])
  const settle = (jobId: bigint, pair = ctx) => call('settle', relay, pair.stack.holding, pair.stack.kind === 'hireling-v1' ? sdk.hirelingHoldingAbi : sdk.jobHoldingAbi, 'settle', [jobId], sdk.V1_GAS.settle)

  if (flow === 'stake-cooldown') {
    const amount = parseUnits('1', 18)
    await call('request-unstake', worker, h.vault, sdk.stakeVaultAbi, 'requestUnstake', [amount])
    const unlock = await j.once(`${scope}/unlock`, async () => (await sdk.getStake(ctx, worker.account.address)).unlockAt)
    await d.waitUntil(flow, unlock)
    await call('withdraw', worker, h.vault, sdk.stakeVaultAbi, 'withdraw', [])
    check('cooldown amount withdrawn', (await sdk.getStake(ctx, worker.account.address)).unstaking, 0n)
  } else if (flow.startsWith('legacy-')) {
    const pair = Object.values(ctx.deployment.legacyStacks).find(p => p.openTokens)
    if (pair === undefined) throw new Error(`${flow}: no configured legacy open-token pair`)
    const legacy = { ...ctx, stack: pair }, x = await publish(legacy)
    if (flow === 'legacy-contest') {
      const entry = await j.once(`${scope}/entry`, () => sdk.signEntry(legacy, worker, x.jobId, d.agentId, sdk.hashText('finished legacy contest work')))
      await call('award', creator, pair.holding, sdk.jobHoldingAbi, 'award', [x.jobId, entry], sdk.V1_GAS.evaluator)
      check('legacy contest completed', (await sdk.getJob(legacy, x.jobId)).statusName, 'Completed')
    } else {
      const arb = d.legacyArbitrator
      if (arb === undefined) throw new Error('legacy-dispute requires LEGACY_ARBITRATOR_PRIVATE_KEY')
      check('legacy key matches evaluator', eq(arb.account.address, await ctx.publicClient.readContract({ address: pair.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'arbitrator' })), true)
      await activate(x, legacy); await submit(x.jobId)
      await call('reject', creator, pair.evaluator, sdk.jobsEvaluatorAbi, 'reject', [x.jobId, 1, sdk.hashText('legacy rejection')])
      await call('dispute', worker, pair.evaluator, sdk.jobsEvaluatorAbi, 'dispute', [x.jobId])
      const r = await j.once(`${scope}/ruling`, async () => { const ruling = { jobId: x.jobId, forWorker: true, slashLoser: false, reasonHash: sdk.hashText('legacy ruling'), deadline: BigInt((await now()) + 3600), nonce: sdk.randomNonce() }; return { ruling, signature: await sdk.signRuling(legacy, arb, ruling) } })
      await call('rule', relay, pair.evaluator, sdk.jobsEvaluatorAbi, 'ruleWithSignature', [r.ruling, r.signature], sdk.V1_GAS.evaluator)
    }
    const oldJob = await sdk.getJob(legacy, x.jobId)
    if (oldJob.statusName !== 'Completed' && !(await sdk.getListing(legacy, x.jobId)).rewardSettled) await settle(x.jobId, legacy)
  } else {
    if (flow === 'fees') {
      const { tiers, staked } = await j.once(`${scope}/tier-input`, async () => ({ tiers: await ctx.publicClient.readContract({ address: h.feeSchedule, abi: sdk.feeScheduleAbi, functionName: 'schedule' }), staked: (await sdk.getStake(ctx, worker.account.address)).staked }))
      if (staked >= tiers.thresholds[1]) throw new Error('fees needs a worker below the second fee tier; use a fresh journal/wallet')
      // One completed job below the threshold; the second snapshots the new tier after stake increases.
      await runV1CoreFlow(d, 'hire', `${scope}/low`)
      const low = await sdk.getV1Listing(ctx, j.state.values[`${scope}/low/jobId`] as bigint)
      check('first fee tier snapshots', low.feeBps, tiers.bps[0])
      const amount = tiers.thresholds[1] - staked
      await approve('approve-stake', worker, h.factory, h.vault, amount)
      await call('stake-tier', worker, h.vault, sdk.stakeVaultAbi, 'stake', [amount])
      workerRewardBefore = await j.once(`${scope}/workerReward-before-second`, () => sdk.balanceOf(ctx, d.token, worker.account.address))
    }
    const x = await publish(), jobId = x.jobId
    let net = 0n, paid = false, slashWorker = false, slashCreator = false
    if (flow === 'cancel') await call('cancel', creator, ctx.stack.holding, sdk.hirelingHoldingAbi, 'cancel', [jobId], sdk.V1_GAS.cancel)
    else {
      net = await activate(x)
      if (flow === 'topup-paid' || flow === 'topup-refund') { await approve('approve-topup', creator, x.p.token, ctx.stack.holding, d.reward / 2n); await call('topup', creator, ctx.stack.holding, sdk.hirelingHoldingAbi, 'topUp', [jobId, d.reward / 2n]) }
      if (flow === 'missed') { await d.waitUntil(flow, x.p.deliveryDeadline + 1); await call('missed', relay, ctx.stack.evaluator, sdk.hirelingEvaluatorAbi, 'rejectAfterDeliveryDeadline', [jobId], sdk.V1_GAS.evaluator); slashWorker = true }
      else {
        await submit(jobId)
        if (flow.startsWith('ruling-') || ['violation','arbitration-timeout','topup-refund'].includes(flow)) {
          const violation = flow === 'topup-refund' ? 0 : 1
          await call('reject', creator, ctx.stack.evaluator, sdk.hirelingEvaluatorAbi, 'reject', [jobId, violation, sdk.hashText(`rejected:${flow}`)])
          if (flow === 'violation' || flow === 'topup-refund') {
            const at = Number(await ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.hirelingEvaluatorAbi, functionName: 'rejectedAt', args: [jobId] }))
            await d.waitUntil(flow, at + x.p.disputeWindow + 1); await call('final-rejection', relay, ctx.stack.evaluator, sdk.hirelingEvaluatorAbi, 'rejectAfterWindow', [jobId], sdk.V1_GAS.evaluator)
            slashWorker = violation !== 0
          } else {
            await call('dispute', worker, ctx.stack.evaluator, sdk.hirelingEvaluatorAbi, 'dispute', [jobId])
            if (flow === 'arbitration-timeout') {
              const at = Number(await ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.hirelingEvaluatorAbi, functionName: 'disputedAt', args: [jobId] }))
              await d.waitUntil(flow, at + x.p.arbitrationWindow + 1); await call('timeout', relay, ctx.stack.evaluator, sdk.hirelingEvaluatorAbi, 'refundAfterArbitrationTimeout', [jobId], sdk.V1_GAS.evaluator)
            } else {
              paid = flow.startsWith('ruling-worker'); slashWorker = !paid && flow.endsWith('-slash'); slashCreator = paid && flow.endsWith('-slash')
              const r = await j.once(`${scope}/ruling`, async () => { const ruling = { jobId, forWorker: paid, slashLoser: slashWorker || slashCreator, reasonHash: sdk.hashText(`ruling:${flow}`), deadline: BigInt((await now()) + 3600), nonce: sdk.randomNonce() }; return { ruling, signature: await sdk.signRuling(ctx, d.arbitrator, ruling) } })
              await call('rule', relay, ctx.stack.evaluator, sdk.hirelingEvaluatorAbi, 'ruleWithSignature', [r.ruling, r.signature], sdk.V1_GAS.evaluator)
            }
          }
        } else if (flow === 'silence') {
          const submittedAt = Number((await sdk.getJob(ctx, jobId)).submittedAt)
          await d.waitUntil(flow, submittedAt + x.p.reviewWindow + 1); await call('silence', relay, ctx.stack.evaluator, sdk.hirelingEvaluatorAbi, 'completeAfterSilence', [jobId], sdk.V1_GAS.evaluator); paid = true
        } else {
          if (d.refusingToken !== undefined) {
            const { parseAbi, maxUint256 } = await import('viem')
            const abi = parseAbi(['function owner() view returns (address)', 'function setBlocked(address,bool)', 'function setHungry(address,uint256)'])
            check('odd token owner', eq(await ctx.publicClient.readContract({ address: d.token, abi, functionName: 'owner' }), d.refusingToken.owner.account.address), true)
            await call('arm-refusing-token', d.refusingToken.owner, d.token, abi, d.refusingToken.kind === 'blocklist' ? 'setBlocked' : 'setHungry', [worker.account.address, d.refusingToken.kind === 'blocklist' ? true : maxUint256])
          }
          await call('accept', creator, ctx.stack.evaluator, sdk.hirelingEvaluatorAbi, 'accept', [jobId], sdk.V1_GAS.evaluator); paid = true
          if (d.refusingToken !== undefined) check('refusing payout defers the core payment', (await sdk.caseOf(ctx, jobId)).payoutDeferred, true)
        }
      }
    }
    if (flow !== 'cancel') await settle(jobId)
    if (flow === 'topup-refund') await call('topup-refund', creator, ctx.stack.holding, sdk.hirelingHoldingAbi, 'claimTopUpRefund', [jobId, creator.account.address], sdk.V1_GAS.claimTopUpRefund)
    const after = await sdk.getV1Listing(ctx, jobId)
    check('settlement outcome', after.outcome, paid ? 1 : 2)
    check('creator bond settled', after.creatorBondSettled, true)
    if (flow !== 'cancel') check('worker bond settled', after.workerBondSettled, true)
    if (flow !== 'fees') {
      check('creator stake burn', (await sdk.getStake(ctx, creator.account.address)).staked, before.creatorStake - (slashCreator ? d.bond : 0n))
      check('worker stake burn', (await sdk.getStake(ctx, worker.account.address)).staked, before.workerStake - (slashWorker ? d.bond : 0n))
    }
    const bonusFee = (after.bonus * BigInt(after.feeBps) + 9999n) / 10000n
    if (d.refusingToken !== undefined) {
      check('exact refused reward is owed', await ctx.publicClient.readContract({ address: ctx.stack.holding, abi: sdk.hirelingHoldingAbi, functionName: 'owed', args: [d.token, worker.account.address] }), net)
      const { parseAbi } = await import('viem')
      const abi = parseAbi(['function setBlocked(address,bool)', 'function setHungry(address,uint256)'])
      await call('clear-refusing-token', d.refusingToken.owner, d.token, abi, d.refusingToken.kind === 'blocklist' ? 'setBlocked' : 'setHungry', [worker.account.address, d.refusingToken.kind === 'blocklist' ? false : 0n])
      await call('withdraw-owed', worker, ctx.stack.holding, sdk.hirelingHoldingAbi, 'withdraw', [d.token], sdk.V1_GAS.claimTopUpRefund)
      check('owed cleared', await ctx.publicClient.readContract({ address: ctx.stack.holding, abi: sdk.hirelingHoldingAbi, functionName: 'owed', args: [d.token, worker.account.address] }), 0n)
    }
    check('worker exact reward', await sdk.balanceOf(ctx, d.token, worker.account.address) - workerRewardBefore, paid ? net + after.bonus - bonusFee : 0n)
    if (flow === 'fees') { const tiers = await ctx.publicClient.readContract({ address: h.feeSchedule, abi: sdk.feeScheduleAbi, functionName: 'schedule' }); check('second fee tier snapshots', after.feeBps, tiers.bps[1]) }
  }
  j.state.values[`${scope}/done`] = true; j.save(j.state); d.log(`${scope}: verified`)
}
