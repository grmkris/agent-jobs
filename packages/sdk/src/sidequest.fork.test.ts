import { parseEther } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forkEnabled, forkSetupTimeout, startSidequestFork } from '../test/sidequest-fixture.ts'
import { activate, balanceOf, cancel, claimTopUpRefund, getJob, getV1Listing, hashText, publish, quoteActivation,
  registerAgent, requestUndelegate, settle, settleDeferred, signSelection, delegate, submit, accept, topUp, withdraw, type ActivationTerms } from './actions.ts'
import { getBacking, getPosition } from './staking.ts'
import { coreAbi } from './abi/index.ts'
import { sidequestLifecycle, sidequestState } from './sidequest.ts'
import { lifecycle } from './lifecycle.ts'
import type { Selection } from './typed-data.ts'

const fork = forkEnabled ? describe : describe.skip
fork('SDK v1 against real bytecode on a local Monad fork', () => {
  let f: Awaited<ReturnType<typeof startSidequestFork>>
  let agentId: bigint
  let sequence = 0
  beforeAll(async () => {
    f = await startSidequestFork()
    agentId = await registerAgent(f.ctx, f.worker, 'https://sidequest.exchange/sdk-local-fork-test')
    await delegate(f.ctx, f.creator, parseEther('100'))
    await delegate(f.ctx, f.worker, parseEther('100'))
  }, forkSetupTimeout())
  afterAll(() => f?.close())

  async function listed() {
    const { ctx, creator, worker, arbitrator } = f
    const now = Number((await ctx.publicClient.getBlock()).timestamp)
    const policy = hashText(`local-fork-${sequence++}`)
    const expected: ActivationTerms = { creator: creator.account.address, approver: creator.account.address,
      token: ctx.stack.factory, reward: 101n, creatorBond: parseEther('10'), workerBond: parseEther('10'),
      arbitrator: arbitrator.account.address, reviewWindow: 3600, disputeWindow: 7200, arbitrationWindow: 43200, deliveryDeadline: now + 3600 }
    const { jobId } = await publish(ctx, creator, { ...expected, manifestHash: hashText('fork'), termsHash: policy })
    const selection: Selection = { jobId, worker: worker.account.address, agentId, termsHash: policy, activateBy: now + 1800, nonce: BigInt(sequence) }
    return { jobId, expected, selection, creatorSig: await signSelection(ctx, creator, selection) }
  }

  it('fee-paying activation funds the core with the quoted net and reserves backing without bond approvals', async () => {
    const x = await listed()
    expect(await quoteActivation(f.ctx, x.jobId, f.worker.account.address)).toEqual([3000, 31n, 70n])
    const nonce = await f.ctx.publicClient.getTransactionCount({ address: f.worker.account.address })
    await expect(activate(f.ctx, f.worker, x.selection, x.creatorSig, { ...x.expected, workerBond: 1n })).rejects.toThrow('workerBond')
    expect(await f.ctx.publicClient.getTransactionCount({ address: f.worker.account.address })).toBe(nonce)
    await activate(f.ctx, f.worker, x.selection, x.creatorSig, x.expected)
    expect((await getJob(f.ctx, x.jobId)).budget).toBe(70n)
    expect((await getV1Listing(f.ctx, x.jobId)).fee).toBe(31n)
    expect((await getBacking(f.ctx, f.worker.account.address)).reserved).toBe(parseEther('10'))
    await expect(requestUndelegate(f.ctx, f.worker, parseEther('101'))).rejects.toThrow()
    await topUp(f.ctx, f.contributor, x.jobId, 11n)
    const before = await balanceOf(f.ctx, f.ctx.stack.factory, f.worker.account.address)
    await submit(f.ctx, f.worker, x.jobId, hashText('finished'))
    const state = await sidequestState(f.ctx, x.jobId)
    expect(state.reviewEndsAt).toBe(state.job.submittedAt + 3600)
    await accept(f.ctx, f.creator, x.jobId)
    expect(lifecycle(await sidequestLifecycle(f.ctx, x.jobId), f.worker.account.address).key).toBe('collect')
    await settle(f.ctx, f.contributor, x.jobId)
    expect((await balanceOf(f.ctx, f.ctx.stack.factory, f.worker.account.address)) - before).toBe(77n)
    expect((await getBacking(f.ctx, f.worker.account.address)).reserved).toBe(0n)
    expect(lifecycle(await sidequestLifecycle(f.ctx, x.jobId)).key).toBe('completed')
  }, 120_000)

  it('records a final worker payment through a paused core, then retries and settles in order', async () => {
    const x = await listed()
    await activate(f.ctx, f.worker, x.selection, x.creatorSig, x.expected)
    await submit(f.ctx, f.worker, x.jobId, hashText('paused-payment'))
    await f.send(f.ctx.deployment.core, coreAbi, 'pause')
    await accept(f.ctx, f.creator, x.jobId)
    expect(await sidequestState(f.ctx, x.jobId)).toMatchObject({ outcome: 'Accepted', deferredDecision: true })
    const phase = lifecycle(await sidequestLifecycle(f.ctx, x.jobId), f.worker.account.address)
    expect(phase).toMatchObject({ key: 'payout-deferred', beneficiary: 'worker', timeout: 'retryDeferred' })
    await f.send(f.ctx.deployment.core, coreAbi, 'unpause')
    const before = await balanceOf(f.ctx, f.ctx.stack.factory, f.worker.account.address)
    await settleDeferred(f.ctx, f.contributor, x.jobId)
    expect((await balanceOf(f.ctx, f.ctx.stack.factory, f.worker.account.address)) - before).toBe(70n)
    expect((await getJob(f.ctx, x.jobId)).statusName).toBe('Rejected')
    expect(lifecycle(await sidequestLifecycle(f.ctx, x.jobId))).toMatchObject({ key: 'completed', beneficiary: 'worker' })
  }, 120_000)

  it('refunds a cancelled offer and a contributor top-up after a missed delivery, then withdraws cooled backing', async () => {
    const cancelled = await listed()
    await cancel(f.ctx, f.creator, cancelled.jobId)
    expect((await getV1Listing(f.ctx, cancelled.jobId)).outcome).toBe(2)
    const x = await listed()
    await activate(f.ctx, f.worker, x.selection, x.creatorSig, x.expected)
    await topUp(f.ctx, f.contributor, x.jobId, 12n)
    await f.rpc('evm_setNextBlockTimestamp', [x.expected.deliveryDeadline + 1])
    await f.rpc('evm_mine')
    const { burnMissedDelivery } = await import('./actions.ts')
    await burnMissedDelivery(f.ctx, f.contributor, x.jobId)
    await settle(f.ctx, f.contributor, x.jobId)
    const before = await balanceOf(f.ctx, f.ctx.stack.factory, f.contributor.account.address)
    await claimTopUpRefund(f.ctx, f.creator, x.jobId, f.contributor.account.address)
    expect((await balanceOf(f.ctx, f.ctx.stack.factory, f.contributor.account.address)) - before).toBe(12n)
    await requestUndelegate(f.ctx, f.worker, parseEther('10'))
    const state = await getPosition(f.ctx, f.worker.account.address, f.worker.account.address)
    await expect(withdraw(f.ctx, f.worker)).rejects.toThrow()
    await f.rpc('evm_setNextBlockTimestamp', [state.unlockAt + 1])
    await f.rpc('evm_mine')
    await withdraw(f.ctx, f.worker)
    expect((await getPosition(f.ctx, f.worker.account.address, f.worker.account.address)).queued).toBe(0n)
  }, 120_000)
})
