import { erc20Abi } from 'viem'
import { parseAbi, parseEther } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forkEnabled, forkSetupTimeout, startSidequestFork } from '../test/sidequest-fixture.ts'
import { registerAgent, delegate } from './actions.ts'
import { FlowJournal, flowJson, parseFlowJson, type FlowState } from './flow-journal.ts'
import { FlowWaiting, V1_CORE_FLOWS, runV1CoreFlow } from './v1-flows.ts'
import { coreAbi, sidequestHoldingAbi } from './abi/index.ts'
import { getBacking, getPosition } from './staking.ts'

const fork = forkEnabled ? describe : describe.skip
fork('live matrix runner against real v1 bytecode', () => {
  let f: Awaited<ReturnType<typeof startSidequestFork>>, agentId: bigint
  beforeAll(async () => {
    f = await startSidequestFork(); agentId = await registerAgent(f.ctx, f.worker, 'https://sidequest.exchange/live-runner-fork')
    await delegate(f.ctx, f.creator, parseEther('1000')); await delegate(f.ctx, f.worker, parseEther('1000'))
    const legacyFactory = await f.deploy('Factory', ['Legacy Factory', 'SIDE', [f.admin.account.address], [parseEther('1000000000')]])
    const legacyHolding = await f.deploy('JobHolding', [f.ctx.deployment.core, legacyFactory, f.ctx.deployment.identity, parseEther('1'), 0n])
    const legacyEvaluator = await f.deploy('JobsEvaluator', [f.ctx.deployment.core, legacyHolding, f.ctx.deployment.reputation, f.arbitrator.account.address, 120, 120, 300, 120])
    await f.send(legacyHolding, sidequestHoldingAbi, 'setEvaluator', [legacyEvaluator])
    await f.send(f.ctx.deployment.core, coreAbi, 'setHookWhitelist', [legacyHolding, true])
    f.ctx = { ...f.ctx, deployment: { ...f.ctx.deployment, legacyStacks: { 'test-legacy': { kind: 'legacy', factory: legacyFactory, holding: legacyHolding, evaluator: legacyEvaluator, openTokens: true } } } }
  }, forkSetupTimeout())
  afterAll(() => f?.close())
  for (const flow of ['delegate', 'slash-pro-rata', 'undelegate-pending-slash'] as const) {
    it(`${flow} proves owned backing and resumes after a withdrawal receipt crash`, async () => {
      const snapshot = await f.rpc('evm_snapshot')
      try {
        expect(V1_CORE_FLOWS).toContain(flow)
        let durable: FlowState = { binding: flow, values: {}, sends: {} }
        let interrupt = true
        const boot = () => new FlowJournal(f.ctx, parseFlowJson(flowJson(durable)), state => {
          durable = parseFlowJson(flowJson(state))
          if (interrupt && state.values[`receipt/${flow}/withdraw-creator`]) throw new Error('crash after delegator withdrawal receipt')
        }, () => undefined)
        const deps = { ...f, relay: f.contributor, agentId, token: f.ctx.stack.factory, reward: 101n, bond: parseEther('10'),
          waitUntil: async (_label: string, timestamp: number) => {
            if (Number((await f.ctx.publicClient.getBlock()).timestamp) < timestamp) {
              await f.rpc('evm_setNextBlockTimestamp', [timestamp])
              await f.rpc('evm_mine')
            }
          }, log: () => undefined }
        await expect(runV1CoreFlow({ ...deps, journal: boot() }, flow)).rejects.toThrow('crash after delegator withdrawal receipt')
        expect(durable.values[`${flow}/done`]).toBeUndefined()
        const originalSends = structuredClone(durable.sends)
        const activation = durable.values[`${flow}/activation-verified`] as { feeBps: number; workerBond: bigint; selfValue: bigint; backing: bigint }
        if (flow === 'delegate') {
          expect(activation.workerBond).toBeGreaterThan(activation.selfValue)
          expect(activation.backing).toBe(parseEther('10000'))
          expect(activation.feeBps).toBe(1000)
          const deposit = durable.values[`${flow}/deposit-creator-verified`] as { delegator: string; payer: string; account: string; position: { shares: bigint } }
          expect(deposit.delegator.toLowerCase()).toBe(f.creator.account.address.toLowerCase())
          expect(deposit.payer.toLowerCase()).toBe(f.creator.account.address.toLowerCase())
          expect(deposit.account.toLowerCase()).toBe(f.worker.account.address.toLowerCase())
          expect(deposit.position.shares).toBeGreaterThan(0n)
        } else {
          type View = { pool: { assets: bigint; shares: bigint; reserved: bigint }; positions: Record<string, { shares: bigint; value: bigint; queuedShares: bigint }> }
          const proof = durable.values[`${flow}/slash-verified`] as { before: View; after: View }
          expect(proof.before.pool.assets - proof.after.pool.assets).toBe(deps.bond)
          const owners = flow === 'slash-pro-rata' ? ['creator', 'relay', 'worker'] : ['creator']
          for (const owner of owners) {
            const before = proof.before.positions[owner]!, after = proof.after.positions[owner]!
            expect(after.shares).toBe(before.shares)
            expect(before.value).toBeGreaterThan(after.value)
            const expectedLoss = before.shares * deps.bond / proof.before.pool.shares
            const residual = before.value - after.value - expectedLoss
            expect(residual >= -1n && residual <= 1n).toBe(true)
          }
          if (flow === 'undelegate-pending-slash') {
            expect(proof.after.positions.creator!.queuedShares).toBeGreaterThan(0n)
            expect(proof.after.pool.reserved).toBeGreaterThan(0n)
            expect(durable.values[`${flow}/blocked-before-slash`]).toMatchObject({ reserved: proof.before.pool.reserved })
            expect(durable.values[`${flow}/blocked-after-slash`]).toMatchObject({ reserved: proof.after.pool.reserved })
          }
        }
        interrupt = false
        await runV1CoreFlow({ ...deps, journal: boot() }, flow)
        for (const [key, saved] of Object.entries(originalSends)) expect(durable.sends[key]).toEqual(saved)
        expect(durable.values[`${flow}/done`]).toBe(true)
        expect((await getPosition(f.ctx, f.worker.account.address, f.creator.account.address)).shares).toBe(0n)
        expect((await getPosition(f.ctx, f.worker.account.address, f.contributor.account.address)).shares).toBe(0n)
        expect((await getBacking(f.ctx, f.worker.account.address)).reserved).toBe(0n)
        if (flow === 'undelegate-pending-slash') {
          const proof = durable.values[`${flow}/slash-verified`] as { after: { positions: { creator: { value: bigint } } } }
          expect(durable.values[`${flow}/withdraw-creator-verified`]).toMatchObject({ assets: proof.after.positions.creator.value })
          expect(durable.values[`${flow}/guard-release-verified`]).toBe(true)
        }
        const nonces = await Promise.all([f.creator, f.worker, f.contributor].map(wallet => f.ctx.publicClient.getTransactionCount({ address: wallet.account.address })))
        await runV1CoreFlow({ ...deps, journal: boot() }, flow)
        expect(await Promise.all([f.creator, f.worker, f.contributor].map(wallet => f.ctx.publicClient.getTransactionCount({ address: wallet.account.address })))).toEqual(nonces)
      } finally { await f.rpc('evm_revert', [snapshot]) }
    }, 120_000)
  }
  it('refuses an unfunded legacy contest before any send, even when the creator holds v2 SIDE', async () => {
    const state: FlowState = { binding: 'legacy-prerequisite', values: {}, sends: {} }
    const journal = new FlowJournal(f.ctx, state, () => undefined, () => undefined)
    const creatorNonce = await f.ctx.publicClient.getTransactionCount({ address: f.creator.account.address })
    await expect(runV1CoreFlow({ ...f, relay: f.contributor, journal, agentId, token: f.ctx.stack.factory, reward: 101n, bond: parseEther('10'),
      waitUntil: async () => undefined, log: () => undefined }, 'legacy-contest')).rejects.toThrow('legacy-contest requires creator to hold at least 1 SIDE v1')
    expect(state.sends).toEqual({})
    expect(await f.ctx.publicClient.getTransactionCount({ address: f.creator.account.address })).toBe(creatorNonce)
    // The later legacy flow exercises the same check and real publish with exactly one old token.
    await f.send(f.ctx.deployment.legacyStacks['test-legacy']!.factory, erc20Abi, 'transfer', [f.creator.account.address, parseEther('1')])
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
      const disputedAt = Number(await f.ctx.publicClient.readContract({ address: f.ctx.stack.evaluator, abi: (await import('./abi/index.ts')).sidequestEvaluatorAbi, functionName: 'disputedAt', args: [timeoutId] }))
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
  for (const flow of V1_CORE_FLOWS.filter(name => !['delegate', 'slash-pro-rata', 'undelegate-pending-slash'].includes(name))) {
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
      const scope = 'owed-interleaved', originalStake = (await getBacking(f.ctx, f.worker.account.address)).active
      // Reproduce an old journal's stale global baseline; the runner must preserve it, not rewrite history.
      const before = { creatorReward: 0n, workerReward: 0n, creatorStake: (await getBacking(f.ctx, f.creator.account.address)).active, workerStake: originalStake }
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
      expect((await getBacking(f.ctx, f.worker.account.address)).active).toBe(originalStake - 2n * base.bond)
      interrupt = true
      await expect(runV1CoreFlow({ ...odd, journal: boot() }, 'hire', scope)).rejects.toThrow('crash after settlement receipt')
      const settleHash = durable.sends[`${scope}/settle`]!.hash
      const credit = (durable.values[`${scope}/activation`] as { net: bigint }).net
      expect(await f.ctx.publicClient.readContract({ address: f.ctx.stack.holding, abi: sidequestHoldingAbi, functionName: 'owed', args: [token, f.worker.account.address] })).toBe(credit)
      interrupt = false
      await runV1CoreFlow({ ...odd, journal: boot() }, 'hire', scope)
      expect(durable.values[`${scope}/done`]).toBe(true)
      expect(durable.values[`${scope}/before`]).toEqual(before)
      expect(durable.sends[`${scope}/settle`]!.hash).toBe(settleHash)
      expect((await getBacking(f.ctx, f.worker.account.address)).active).toBe(originalStake - 2n * base.bond)
      expect(await f.ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [f.worker.account.address] })).toBe(credit)
      const nonces = await Promise.all([f.creator, f.worker, f.admin, f.contributor].map(w => f.ctx.publicClient.getTransactionCount({ address: w.account.address })))
      await runV1CoreFlow({ ...odd, journal: boot() }, 'hire', scope)
      expect(await Promise.all([f.creator, f.worker, f.admin, f.contributor].map(w => f.ctx.publicClient.getTransactionCount({ address: w.account.address })))).toEqual(nonces)
    } finally { await f.rpc('evm_revert', [snapshot]) }
  }, 120_000)
})
