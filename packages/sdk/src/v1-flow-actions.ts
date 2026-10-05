/** Shared job and persisted-send operations for the testnet flow matrix. */
import { type Abi, type Address, type TransactionReceipt, decodeEventLog } from 'viem'
import * as sdk from './index.ts'
import type { V1CoreFlow, V1FlowDeps } from './v1-flows.ts'

export function v1FlowActions(d: V1FlowDeps, flow: V1CoreFlow, scope: string) {
  const { ctx, creator, worker, relay, journal: j } = d
  const receipts = new Map<string, TransactionReceipt>()

  async function now() {
    return Number((await ctx.publicClient.getBlock()).timestamp)
  }
  async function call(label: string, wallet: sdk.Wallet, target: Address, abi: readonly unknown[], fn: string, args: readonly unknown[], gas?: bigint) {
    const receipt = await j.contract(`${scope}/${label}`, wallet, target, abi as Abi, fn, args, gas)
    receipts.set(label, receipt)
    return receipt
  }
  async function approve(label: string, wallet: sdk.Wallet, token: Address, spender: Address, amount: bigint) {
    const needed = await j.once(`${scope}/${label}/needed`, async () => {
      const allowance = await ctx.publicClient.readContract({ address: token, abi: sdk.factoryTokenAbi,
        functionName: 'allowance', args: [wallet.account.address, spender] })
      return allowance < amount
    })
    if (needed) await call(label, wallet, token, sdk.factoryTokenAbi, 'approve', [spender, amount])
  }
  async function publish(pair = ctx, options: { workerBond?: bigint; deliverySeconds?: number } = {}) {
    const p = await j.once(`${scope}/offer`, async () => {
      const t = await now()
      const deadline = t + (flow === 'missed' ? 120 : options.deliverySeconds ?? 6 * 3600)
      const limits = pair.stack.kind === 'hireling-v1' ? sdk.minimumOfferWindows(await sdk.readWindowBounds(pair)) : null
      const windows = limits === null ? { reviewWindow: 0, disputeWindow: 0, arbitrationWindow: 0 }
        : { reviewWindow: limits.reviewSeconds, disputeWindow: limits.disputeSeconds, arbitrationWindow: limits.arbitrationSeconds }
      return {
        token: d.token,
        reward: d.reward,
        creatorBond: flow.startsWith('legacy-') ? 0n : d.bond,
        workerBond: flow.startsWith('legacy-') ? 0n : options.workerBond ?? d.bond,
        approver: creator.account.address,
        manifestHash: sdk.hashText(`v1 flow ${flow}`),
        policyHash: sdk.hashText(`${flow}:${t}:${sdk.randomNonce()}`),
        deliveryDeadline: deadline,
        expiredAt: await sdk.minExpiry(pair, deadline, windows),
        ...windows,
        arbitrator: d.arbitrator.account.address,
      }
    })
    await approve('approve-reward', creator, p.token, pair.stack.holding, p.reward)
    const request = pair.stack.kind === 'hireling-v1' ? p : {
      approver: p.approver,
      manifestHash: p.manifestHash,
      policyHash: p.policyHash,
      token: p.token,
      reward: p.reward,
      creatorBond: 0n,
      workerBond: 0n,
      deliveryDeadline: p.deliveryDeadline,
      expiredAt: p.expiredAt,
      mode: flow === 'legacy-contest' ? 1 : 0,
      selectionDeadline: flow === 'legacy-contest' ? p.deliveryDeadline - 60 : 0,
    }
    const abi = pair.stack.kind === 'hireling-v1' ? sdk.hirelingHoldingAbi : sdk.jobHoldingAbi
    const receipt = await call('publish', creator, pair.stack.holding, abi, 'publish', [request])
    let jobId: bigint | undefined
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== pair.stack.holding.toLowerCase()) continue
      try {
        const event = decodeEventLog({ abi, data: log.data, topics: log.topics })
        if (event.eventName === 'Published') jobId = event.args.jobId
      } catch { /* Other logs. */ }
    }
    if (jobId === undefined) throw new Error(`${flow}: no canonical Published event`)
    j.state.values[`${scope}/jobId`] = jobId
    j.save(j.state)
    return { p, jobId }
  }
  async function activate(x: Awaited<ReturnType<typeof publish>>, pair = ctx) {
    const selectionData = await j.once(`${scope}/selection`, async () => {
      const listing = await sdk.getListing(pair, x.jobId)
      if (pair.stack.kind === 'hireling-v1')
        sdk.assertActivationTerms(await sdk.getV1Listing(pair, x.jobId), { ...x.p, creator: creator.account.address })
      const selection = { jobId: x.jobId, worker: worker.account.address, agentId: d.agentId,
        termsHash: x.p.policyHash, activateBy: x.p.deliveryDeadline - 1, nonce: sdk.randomNonce() }
      const sig = await sdk.signSelection(pair, creator, selection)
      return { selection, sig, reward: listing.reward }
    })
    // Requote an unsigned attempt. A saved send resumes its exact bytes and original authorization.
    let data: typeof selectionData & { auth: sdk.Authorization; net: bigint }
    if (j.state.sends[`${scope}/activate`] === undefined) {
      const net = pair.stack.kind === 'hireling-v1'
        ? (await sdk.quoteActivation(pair, x.jobId, worker.account.address))[2] : selectionData.reward
      const auth = await sdk.signBudget(pair, worker, {
        jobId: x.jobId, token: x.p.token, amount: net, deadline: BigInt(await now() + 3600),
      })
      data = { ...selectionData, auth, net }
      j.state.values[`${scope}/activation`] = data
      j.save(j.state)
    } else {
      data = j.state.values[`${scope}/activation`] as typeof data
    }
    await call('activate', worker, pair.stack.holding, pair.stack.kind === 'hireling-v1' ? sdk.hirelingHoldingAbi : sdk.jobHoldingAbi,
      'activate', [data.selection, data.sig, data.auth])
    return data.net
  }
  function submit(jobId: bigint) {
    return call('submit', worker, ctx.deployment.core, sdk.coreAbi, 'submit', [jobId, sdk.hashText(`deliverable:${flow}`), '0x'])
  }
  function settle(jobId: bigint, pair = ctx) {
    return call('settle', relay, pair.stack.holding, pair.stack.kind === 'hireling-v1' ? sdk.hirelingHoldingAbi : sdk.jobHoldingAbi,
      'settle', [jobId], sdk.V1_GAS.settle)
  }
  return { now, receipts, call, approve, publish, activate, submit, settle }
}
