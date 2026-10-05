import { parseAbi, parseEther } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forkEnabled, forkSetupTimeout, startHirelingFork } from '../test/hireling-fixture.ts'
import { getStake, registerAgent, delegate } from './actions.ts'
import { FlowJournal, flowJson, parseFlowJson, type FlowState } from './flow-journal.ts'
import { FlowWaiting, V1_CORE_FLOWS, runV1CoreFlow } from './v1-flows.ts'
import { coreAbi, factoryTokenAbi, hirelingHoldingAbi } from './abi/index.ts'

const fork = forkEnabled ? describe : describe.skip
fork('live matrix runner against real v1 bytecode', () => {
  let f: Awaited<ReturnType<typeof startHirelingFork>>, agentId: bigint
  beforeAll(async () => {
    f = await startHirelingFork(); agentId = await registerAgent(f.ctx, f.worker, 'https://hireling.xyz/live-runner-fork')
    await delegate(f.ctx, f.creator, parseEther('1000')); await delegate(f.ctx, f.worker, parseEther('1000'))
    const legacyFactory = await f.deploy('Factory', ['Legacy Factory', 'FACTORY', [f.admin.account.address], [parseEther('1000000000')]])
    const legacyHolding = await f.deploy('JobHolding', [f.ctx.deployment.core, legacyFactory, f.ctx.deployment.identity, parseEther('1'), 0n])
    const legacyEvaluator = await f.deploy('JobsEvaluator', [f.ctx.deployment.core, legacyHolding, f.ctx.deployment.reputation, f.arbitrator.account.address, 120, 120, 300, 120])
    await f.send(legacyHolding, hirelingHoldingAbi, 'setEvaluator', [legacyEvaluator])
    await f.send(f.ctx.deployment.core, coreAbi, 'setHookWhitelist', [legacyHolding, true])
    f.ctx = { ...f.ctx, deployment: { ...f.ctx.deployment, legacyStacks: { 'test-legacy': { kind: 'legacy', factory: legacyFactory, holding: legacyHolding, evaluator: legacyEvaluator, openTokens: true } } } }
  }, forkSetupTimeout())
  afterAll(() => f?.close())
  it('refuses an unfunded legacy contest before any send, even when the creator holds v2 FACTORY', async () => {
    const state: FlowState = { binding: 'legacy-prerequisite', values: {}, sends: {} }
    const journal = new FlowJournal(f.ctx, state, () => undefined, () => undefined)
    const creatorNonce = await f.ctx.publicClient.getTransactionCount({ address: f.creator.account.address })
    await expect(runV1CoreFlow({ ...f, relay: f.contributor, journal, agentId, token: f.ctx.stack.factory, reward: 101n, bond: parseEther('10'),
      waitUntil: async () => undefined, log: () => undefined }, 'legacy-contest')).rejects.toThrow('legacy-contest requires creator to hold at least 1 FACTORY v1')
    expect(state.sends).toEqual({})
    expect(await f.ctx.publicClient.getTransactionCount({ address: f.creator.account.address })).toBe(creatorNonce)
    // The later legacy flow exercises the same check and real publish with exactly one old token.
    await f.send(f.ctx.deployment.legacyStacks['test-legacy']!.factory, factoryTokenAbi, 'transfer', [f.creator.account.address, parseEther('1')])
  }, 120_000)
  it('starts both clocks in one journal, interleaves payment/slash, and resumes after a terminal receipt crash', async () => {
    const snapshot = await f.rpc('evm_snapshot')
    try {
      let durable: FlowState = { binding: 'scheduled', values: {}, sends: {} }, interrupt = false
      const boot = () => new FlowJournal(f.ctx, parseFlowJson(flowJson(durable)), state => {
        durable = parseFlowJson(flowJson(state))
        if (interrupt && state.values['receipt/arbitration-timeout/timeout']) throw new Error('crash after timeout receipt')
      }, () => undefined)
      const deps = { ...f, relay: f.contributor, agentId, token: f.ctx.stack.factory, reward: 101n, bond: parseEther('10'),
        log: () => undefined, waitUntil: async (label: string, timestamp: number) => {
          if (Number((await f.ctx.publicClient.getBlock()).timestamp) < timestamp) throw new FlowWaiting(label, timestamp)
        } }
      await expect(runV1CoreFlow({ ...deps, journal: boot() }, 'stake-cooldown')).rejects.toBeInstanceOf(FlowWaiting)
      await expect(runV1CoreFlow({ ...deps, journal: boot() }, 'arbitration-timeout')).rejects.toBeInstanceOf(FlowWaiting)
      expect(durable.values['stake-cooldown/done']).toBeUndefined()
      expect(durable.values['arbitration-timeout/done']).toBeUndefined()
      await runV1CoreFlow({ ...deps, journal: boot() }, 'hire')
      await runV1CoreFlow({ ...deps, journal: boot() }, 'ruling-creator-slash')
      const timeoutId = durable.values['arbitration-timeout/jobId'] as bigint
      const disputedAt = Number(await f.ctx.publicClient.readContract({ address: f.ctx.stack.evaluator, abi: (await import('./abi/index.ts')).hirelingEvaluatorAbi, functionName: 'disputedAt', args: [timeoutId] }))
      await f.rpc('evm_setNextBlockTimestamp', [disputedAt + 43201]); await f.rpc('evm_mine')
      interrupt = true
      await expect(runV1CoreFlow({ ...deps, journal: boot() }, 'arbitration-timeout')).rejects.toThrow('crash after timeout receipt')
      const timeoutHash = durable.sends['arbitration-timeout/timeout']!.hash
      interrupt = false
      await runV1CoreFlow({ ...deps, journal: boot() }, 'arbitration-timeout')
      expect(durable.values['arbitration-timeout/done']).toBe(true)
      expect(durable.sends['arbitration-timeout/timeout']!.hash).toBe(timeoutHash)
      await f.rpc('evm_setNextBlockTimestamp', [durable.values['stake-cooldown/unlock']]); await f.rpc('evm_mine')
      await runV1CoreFlow({ ...deps, journal: boot() }, 'stake-cooldown')
      expect(durable.values['stake-cooldown/done']).toBe(true)
    } finally { await f.rpc('evm_revert', [snapshot]) }
  }, 120_000)
  for (const flow of V1_CORE_FLOWS) {
    it(`runs ${flow} through the same persisted send path used live`, async () => {
      const state: FlowState = { binding: 'fork', values: {}, sends: {} }
      const j = new FlowJournal(f.ctx, state, () => undefined, () => undefined)
      await runV1CoreFlow({ ...f, relay: f.contributor, journal: j, legacyArbitrator: f.arbitrator, agentId, token: f.ctx.stack.factory, reward: 101n, bond: parseEther('10'),
        waitUntil: async (_label, t) => { if (Number((await f.ctx.publicClient.getBlock()).timestamp) < t) { await f.rpc('evm_setNextBlockTimestamp', [t]); await f.rpc('evm_mine') } }, log: () => undefined }, flow)
      expect(state.values[`${flow}/done`]).toBe(true)
      const nonce = await f.ctx.publicClient.getTransactionCount({ address: f.creator.account.address })
      await runV1CoreFlow({ ...f, relay: f.contributor, journal: j, agentId, token: f.ctx.stack.factory, reward: 101n, bond: parseEther('10'), waitUntil: async () => { throw new Error('already done') }, log: () => undefined }, flow)
      expect(await f.ctx.publicClient.getTransactionCount({ address: f.creator.account.address })).toBe(nonce)
    }, 120_000)
  }
  for (const kind of ['blocklist', 'gasBurner'] as const) {
    it(`a real ${kind} refusal lands the decision and bonds, then collects exact owed funds`, async () => {
      const token = await f.deploy(kind === 'blocklist' ? 'BlocklistUSD' : 'GasBurnerUSD', [f.admin.account.address], 'OddTokens')
      await f.send(token, parseAbi(['function mint(address,uint256)']), 'mint', [f.creator.account.address, 1000n])
      let durable: FlowState = { binding: 'odd-fork', values: {}, sends: {} }, interrupt = true
      const scope = `owed-${kind}`, boot = () => new FlowJournal(f.ctx, parseFlowJson(flowJson(durable)), state => {
        durable = parseFlowJson(flowJson(state))
        if (interrupt && state.values[`receipt/${scope}/withdraw-owed`]) throw new Error('crash after withdrawal receipt')
      }, () => undefined)
      const deps = { ...f, relay: f.contributor, agentId, token, reward: 101n, bond: parseEther('10'),
        refusingToken: { kind, owner: f.admin }, waitUntil: async () => undefined, log: () => undefined }
      await expect(runV1CoreFlow({ ...deps, journal: boot() }, 'hire', scope)).rejects.toThrow('crash after withdrawal receipt')
      expect(durable.values[`${scope}/done`]).toBeUndefined()
      const nonces = await Promise.all([f.creator, f.worker, f.admin, f.contributor].map(w => f.ctx.publicClient.getTransactionCount({ address: w.account.address })))
      interrupt = false
      await runV1CoreFlow({ ...f, relay: f.contributor, journal: boot(), agentId, token, reward: 101n, bond: parseEther('10'),
        refusingToken: { kind, owner: f.admin }, waitUntil: async () => undefined, log: () => undefined }, 'hire', `owed-${kind}`)
      expect(durable.values[`owed-${kind}/done`]).toBe(true)
      expect(await Promise.all([f.creator, f.worker, f.admin, f.contributor].map(w => f.ctx.publicClient.getTransactionCount({ address: w.account.address })))).toEqual(nonces)
    }, 120_000)
  }
  it('resumes an unfunded odd-token attempt across unrelated burns and a settlement receipt crash', async () => {
    const snapshot = await f.rpc('evm_snapshot')
    try {
      const token = await f.deploy('BlocklistUSD', [f.admin.account.address], 'OddTokens')
      const scope = 'owed-interleaved', originalStake = (await getStake(f.ctx, f.worker.account.address)).staked
      // Reproduce an old journal's stale global baseline; the runner must preserve it, not rewrite history.
      const before = { creatorReward: 0n, workerReward: 0n, creatorStake: (await getStake(f.ctx, f.creator.account.address)).staked, workerStake: originalStake }
      let durable: FlowState = { binding: 'odd-interleaved', values: { [`${scope}/before`]: before }, sends: {} }, interrupt = false
      const boot = () => new FlowJournal(f.ctx, parseFlowJson(flowJson(durable)), state => {
        durable = parseFlowJson(flowJson(state))
        if (interrupt && state.values[`receipt/${scope}/settle`]) throw new Error('crash after settlement receipt')
      }, () => undefined)
      const waitUntil = async (_label: string, t: number) => {
        if (Number((await f.ctx.publicClient.getBlock()).timestamp) < t) { await f.rpc('evm_setNextBlockTimestamp', [t]); await f.rpc('evm_mine') }
      }
      const base = { ...f, relay: f.contributor, agentId, reward: 101n, bond: parseEther('10'), waitUntil, log: () => undefined }
      const odd = { ...base, token, refusingToken: { kind: 'blocklist' as const, owner: f.admin } }
      await expect(runV1CoreFlow({ ...odd, journal: boot() }, 'hire', scope)).rejects.toThrow()
      expect(durable.sends[`${scope}/publish`]).toBeUndefined()
      await f.send(token, parseAbi(['function mint(address,uint256)']), 'mint', [f.creator.account.address, 1000n])
      for (const flow of ['violation', 'missed'] as const) await runV1CoreFlow({ ...base, token: f.ctx.stack.factory, journal: boot() }, flow)
      expect((await getStake(f.ctx, f.worker.account.address)).staked).toBe(originalStake - 2n * base.bond)
      interrupt = true
      await expect(runV1CoreFlow({ ...odd, journal: boot() }, 'hire', scope)).rejects.toThrow('crash after settlement receipt')
      const settleHash = durable.sends[`${scope}/settle`]!.hash
      const credit = (durable.values[`${scope}/activation`] as { net: bigint }).net
      expect(await f.ctx.publicClient.readContract({ address: f.ctx.stack.holding, abi: hirelingHoldingAbi, functionName: 'owed', args: [token, f.worker.account.address] })).toBe(credit)
      interrupt = false
      await runV1CoreFlow({ ...odd, journal: boot() }, 'hire', scope)
      expect(durable.values[`${scope}/done`]).toBe(true)
      expect(durable.values[`${scope}/before`]).toEqual(before)
      expect(durable.sends[`${scope}/settle`]!.hash).toBe(settleHash)
      expect((await getStake(f.ctx, f.worker.account.address)).staked).toBe(originalStake - 2n * base.bond)
      expect(await f.ctx.publicClient.readContract({ address: token, abi: factoryTokenAbi, functionName: 'balanceOf', args: [f.worker.account.address] })).toBe(credit)
      const nonces = await Promise.all([f.creator, f.worker, f.admin, f.contributor].map(w => f.ctx.publicClient.getTransactionCount({ address: w.account.address })))
      await runV1CoreFlow({ ...odd, journal: boot() }, 'hire', scope)
      expect(await Promise.all([f.creator, f.worker, f.admin, f.contributor].map(w => f.ctx.publicClient.getTransactionCount({ address: w.account.address })))).toEqual(nonces)
    } finally { await f.rpc('evm_revert', [snapshot]) }
  }, 120_000)
})
