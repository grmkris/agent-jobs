import { parseAbi, parseEther } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forkEnabled, startHirelingFork } from '../test/hireling-fixture.ts'
import { registerAgent, stake } from './actions.ts'
import { FlowJournal, flowJson, parseFlowJson, type FlowState } from './flow-journal.ts'
import { V1_CORE_FLOWS, runV1CoreFlow } from './v1-flows.ts'
import { coreAbi, hirelingHoldingAbi } from './abi/index.ts'

const fork = forkEnabled ? describe : describe.skip
fork('live matrix runner against real v1 bytecode', () => {
  let f: Awaited<ReturnType<typeof startHirelingFork>>, agentId: bigint
  beforeAll(async () => {
    f = await startHirelingFork(); agentId = await registerAgent(f.ctx, f.worker, 'https://hireling.xyz/live-runner-fork')
    await stake(f.ctx, f.creator, parseEther('1000')); await stake(f.ctx, f.worker, parseEther('1000'))
    const legacyHolding = await f.deploy('JobHolding', [f.ctx.deployment.core, f.ctx.stack.factory, f.ctx.deployment.identity, 0n, 0n])
    const legacyEvaluator = await f.deploy('JobsEvaluator', [f.ctx.deployment.core, legacyHolding, f.ctx.deployment.reputation, f.arbitrator.account.address, 120, 120, 300, 120])
    await f.send(legacyHolding, hirelingHoldingAbi, 'setEvaluator', [legacyEvaluator])
    await f.send(f.ctx.deployment.core, coreAbi, 'setHookWhitelist', [legacyHolding, true])
    f.ctx = { ...f.ctx, deployment: { ...f.ctx.deployment, legacyStacks: { 'test-legacy': { kind: 'legacy', factory: f.ctx.stack.factory, holding: legacyHolding, evaluator: legacyEvaluator, openTokens: true } } } }
  }, 180_000)
  afterAll(() => f?.close())
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
})
