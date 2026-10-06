import { expect, test } from 'bun:test'
import { forkEnabled, forkSetupTimeout, startSidequestFork } from '../../packages/sdk/test/sidequest-fixture.ts'
import { accept, activate, hashText, publish, registerAgent, settle, signSelection, submit, topUp } from '../../packages/sdk/src/actions.ts'
import { holdingLogs, topUpLogs } from './chain.ts'
import { computeEpoch } from './compute.ts'
import { parseEther, type Address } from './viem.ts'

/** Sends only to local Anvil. Real Holding events prove contribution reads span the fee window boundary. */
test.skipIf(!forkEnabled)('real paid-job fees include earlier top-ups in the 40-percent creator allocation', async () => {
  const f = await startSidequestFork()
  try {
    const { ctx, creator, worker, contributor, arbitrator } = f
    const historyStart = await ctx.publicClient.getBlockNumber()
    const agentId = await registerAgent(ctx, worker, 'https://sidequest.exchange/mining-local-fork')
    const now = Number((await ctx.publicClient.getBlock()).timestamp)
    const terms = {
      creator: creator.account.address, approver: creator.account.address, token: ctx.stack.factory,
      reward: parseEther('100'), creatorBond: 0n, workerBond: 0n, arbitrator: arbitrator.account.address,
      reviewWindow: 3600, disputeWindow: 7200, arbitrationWindow: 43200, deliveryDeadline: now + 86400,
    }
    const termsHash = hashText('mining-contributors-fork')
    const { jobId } = await publish(ctx, creator, { ...terms, mode: 'hire', manifestHash: hashText('fixture'), termsHash })
    const selection = { jobId, worker: worker.account.address, agentId, termsHash, activateBy: now + 1800, nonce: 1n }
    await activate(ctx, worker, selection, await signSelection(ctx, creator, selection), terms)
    await topUp(ctx, contributor, jobId, parseEther('10'))
    await topUp(ctx, creator, jobId, parseEther('20'))
    const beforeSettlement = await ctx.publicClient.getBlockNumber()
    await f.rpc('evm_setNextBlockTimestamp', [now + 3601])
    await submit(ctx, worker, jobId, hashText('finished'))
    await accept(ctx, creator, jobId)
    await settle(ctx, contributor, jobId)
    const head = await ctx.publicClient.getBlockNumber()
    const logs = await holdingLogs(ctx.publicClient, [ctx.stack.holding], beforeSettlement + 1n, head, 1000n)
    expect(logs.fees).toHaveLength(1)
    expect(logs.fees[0]?.amount).toBe(parseEther('39'))
    expect(logs.fees[0]?.bonusPart).toBe(parseEther('9'))
    const contributions = await topUpLogs(ctx.publicClient, logs.fees, historyStart, head, 1000n)
    expect(contributions).toHaveLength(2)
    const token = ctx.stack.factory.toLowerCase() as Address
    const result = computeEpoch({ ...logs, topUps: contributions, budget: parseEther('1000000'),
      prices: { epoch: 0n, tokens: [{ token, decimals: 18, usdPrice: parseEther('1') }], factoryUsdPrice: parseEther('1') } })
    const claims = new Map(result.leaves.map(leaf => [leaf.account, leaf.amount]))
    expect(claims.get(worker.account.address.toLowerCase() as Address)).toBe(parseEther('11.7'))
    expect(claims.get(creator.account.address.toLowerCase() as Address)).toBe(parseEther('7.2'))
    expect(claims.get(contributor.account.address.toLowerCase() as Address)).toBe(parseEther('0.6'))
  } finally {
    f.close()
  }
}, forkSetupTimeout() + 120_000)
