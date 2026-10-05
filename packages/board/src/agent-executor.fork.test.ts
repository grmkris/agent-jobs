/** Cryptographic fixture signers, real SQLite and real delegation/Hireling contracts on a Monad fork. */
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Hex, type LocalAccount, decodeFunctionData, erc20Abi, parseEther } from 'viem'
import * as sdk from '@agent-jobs/sdk'
import { startHirelingFork, forkEnabled, forkSetupTimeout } from '../../sdk/test/hireling-fixture.ts'
import { Board, BoardError } from './service.ts'
import { fromNodeSqlite } from './store.ts'
import { AgentStore } from './agents.ts'
import { AgentSigning, type RoutineSigner } from './agent-signing.ts'
import { AgentExecutor, type AgentPreparedCall, type AgentToolRequest } from './agent-executor.ts'
import { GrantStore } from './grants.ts'
import { SponsorDesk } from './sponsor.ts'
import { mapAgentCalls } from './agent-call-mapper.ts'
import { ensureAgentGrants } from './agent-grant-renewal.ts'
import { AgentLifecycle } from './agent-lifecycle.ts'

const suite = forkEnabled ? describe : describe.skip
const fixtureWallet = (fixture: Awaited<ReturnType<typeof startHirelingFork>>, id: string) => id === 'creator-agent-wallet' ? fixture.contributor : fixture.worker
suite('agent executor through real contracts', () => {
  let fixture: Awaited<ReturnType<typeof startHirelingFork>>
  let ctx: sdk.Ctx
  let db: DatabaseSync
  let boardDb: DatabaseSync
  let board: Board
  let agents: AgentStore
  let grants: GrantStore
  let signing: AgentSigning
  let now: number
  let workerId: bigint
  let allowanceHash: Hex
  const token = sdk.deployment('monad-testnet').rewardTokens[0]!
  const bootSponsor = () => new SponsorDesk({ sql: fromNodeSqlite(db), ctx, now: () => now, relay: { account: fixture.admin.account as LocalAccount, rpcUrl: fixture.url }, fail: (code, message) => new BoardError(code, message) })

  /** Local fixture accounts produce real ECDSA signatures; provider authorization remains covered by the live Privy proof. */
  function fixtureSigner(): RoutineSigner {
    return {
      signTypedData: (id, data) => sdk.signTypedDataJson(fixtureWallet(fixture, id), data),
      signAuthorization: (id, contract, chainId, nonce) => fixtureWallet(fixture, id).signAuthorization({ contractAddress: contract, chainId, nonce, executor: fixture.admin.account.address }),
    }
  }

  async function tool(request: AgentToolRequest): Promise<AgentPreparedCall> {
    const a = request.args
    switch (request.tool) {
      case 'create_task': return board.createTask(request.caller, a as never) as unknown as AgentPreparedCall
      case 'select_worker': return board.selectWorker(request.caller, a as never)
      case 'submit_selection': return board.submitSelection(request.caller, a as never)
      case 'prepare_activation': return board.prepareActivation(request.caller, a as never)
      case 'build_activation': return board.buildActivation(request.caller, a as never)
      case 'cancel_task': return board.cancelTask(request.caller, a as never)
      case 'request_unstake': return board.requestUnstake(request.caller, a as never)
      case 'report_transaction': {
        await board.reportTransaction(request.caller, a as never)
        return { reported: true }
      }
      case 'report_operation': return board.reportOperation(request.caller, a as never)
      default: throw new Error('Unexpected fixture tool')
    }
  }

  const boot = () => new AgentExecutor({ sql: fromNodeSqlite(db), now: () => now, context: ctx, sponsor: bootSponsor(), signing,
    prepareTool: tool, verifyToolSigning: request => board.verifyAgentSigning(request.caller, request) })

  const offer = (reward = '10', title = 'Executor fixture hire') => ({ title, brief: 'Public fork proof', acceptanceCriteria: ['finished'], token,
    reward, creatorBond: '0', workerBond: '0', deliveryDeadline: now + 86400, mode: 'hire' as const,
    windows: { reviewSeconds: 3600, disputeSeconds: 3600, arbitrationSeconds: 43200 }, invite: { agentId: workerId.toString() } })

  async function confirm(wallet: sdk.Wallet, spec: sdk.GrantSpec): Promise<Hex> {
    const prepared = grants.prepare(fixture.creator.account.address, spec)
    await grants.confirm(prepared.hash, await sdk.signTypedDataJson(wallet, prepared.typedData))
    return prepared.hash
  }

  beforeAll(async () => {
    fixture = await startHirelingFork()
    ctx = { ...fixture.ctx, deployment: { ...fixture.ctx.deployment, relay: fixture.admin.account.address } }
    now = Number((await ctx.publicClient.getBlock()).timestamp)
    db = new DatabaseSync(':memory:')
    boardDb = new DatabaseSync(':memory:')
    board = new Board(fromNodeSqlite(boardDb), { network: 'monad-testnet', contexts: { main: ctx }, domain: 'fork.test', uri: 'https://fork.test', manifestBaseUrl: 'https://fork.test/offers', now: () => now })
    agents = new AgentStore(fromNodeSqlite(db), () => now)
    grants = new GrantStore(fromNodeSqlite(db), ctx)
    signing = new AgentSigning(fromNodeSqlite(db), ctx, fixtureSigner(), () => now)
    workerId = await sdk.registerAgent(ctx, fixture.worker, 'https://hireling.xyz/executor-fixture')
    for (const [id, wallet, walletId] of [['creator-agent', fixture.contributor, 'creator-agent-wallet'], ['worker-agent', fixture.worker, 'worker-agent-wallet']] as const) {
      agents.create({ id, operator: fixture.creator.account.address, privyUserId: 'did:privy:fork-fixture', name: id, registry: ctx.deployment.identity, chainId: ctx.deployment.chainId })
      agents.bindWallet(id, walletId, wallet.account.address)
      const authorization = await wallet.signAuthorization({ contractAddress: ctx.deployment.delegation.delegator, executor: fixture.admin.account.address })
      const hash = await fixture.admin.sendTransaction({ to: wallet.account.address, data: '0x', authorizationList: [authorization] })
      expect((await ctx.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success')
      for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const) agents.advance(id, state)
    }
    const operatorAuthorization = await fixture.creator.signAuthorization({ contractAddress: ctx.deployment.delegation.delegator, executor: fixture.admin.account.address })
    await ctx.publicClient.waitForTransactionReceipt({ hash: await fixture.admin.sendTransaction({ to: fixture.creator.account.address, data: '0x', authorizationList: [operatorAuthorization] }) })
    await fixture.send(token, [...erc20Abi, { type: 'function', name: 'mint', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }], 'mint', [fixture.creator.account.address, 100_000_000n])
    allowanceHash = await confirm(fixture.creator, { kind: 'allowance', delegator: fixture.creator.account.address, agent: fixture.contributor.account.address, token, amount: 25_000_000n, salt: 1n, start: now })
  }, forkSetupTimeout())

  afterAll(() => { db?.close(); boardDb?.close(); fixture?.close() })

  it('executes a zero-balance hire, reports its chain receipt and recovers the same send after reconstruction', async () => {
    const input = { agentId: 'creator-agent', boardId: 'public', operationKey: 'hire-one', tool: 'create_task', args: offer() }
    const result = await boot().execute(input)
    expect(result.status).toBe('confirmed')
    const output = result as { result: { taskId: string; applicationId: string; sponsorship: { txHash: Hex } } }
    const task = await board.getTask({ address: fixture.contributor.account.address }, { taskId: output.result.taskId })
    expect(task.jobId).not.toBeNull()
    expect(task.creator.toLowerCase()).toBe(fixture.contributor.account.address.toLowerCase())
    const nonce = await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })
    expect(await boot().execute(input)).toEqual(result)
    expect(await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })).toBe(nonce)
    expect(db.prepare('SELECT count(*) AS count FROM sponsor_operations').get()).toEqual({ count: 1 })
    const selection = await boot().execute({ agentId: 'creator-agent', boardId: 'public', operationKey: 'selection-one', tool: 'select_worker', args: { taskId: task.taskId, applicationId: output.result.applicationId } })
    expect(selection.status).toBe('confirmed')
    const activation = await boot().execute({ agentId: 'worker-agent', boardId: 'public', operationKey: 'activation-one', tool: 'prepare_activation', args: { taskId: task.taskId } })
    expect(activation.status).toBe('confirmed')
    expect((await board.getTask({}, { taskId: task.taskId })).chain.status).toBe('active')
    expect(db.prepare('SELECT count(*) AS count FROM agent_sign_requests WHERE purpose LIKE ?').get('tool:%')).toEqual({ count: 2 })
  }, 180_000)

  it('uses available period capacity rather than requiring a reward equal to the cap, and requests exact approval above it', async () => {
    const first = await boot().execute({ agentId: 'creator-agent', boardId: 'public', operationKey: 'hire-two', tool: 'create_task', args: offer('10', 'Executor first') })
    expect(first.status).toBe('confirmed')
    const third = await boot().execute({ agentId: 'creator-agent', boardId: 'public', operationKey: 'hire-over', tool: 'create_task', args: offer('10', 'Executor second') })
    expect(third.status).toBe('approval')
    if (third.status !== 'approval') throw new Error('Expected an approval')
    const request = JSON.parse(third.approval.request_json)
    expect(request).toMatchObject({ token, amount: '10000000', reason: 'allowance-unavailable' })
    const once = await confirm(fixture.creator, { kind: 'allowance-once', delegator: fixture.creator.account.address, agent: fixture.contributor.account.address, token, amount: 10_000_000n, salt: 99n, start: now })
    agents.decide(third.operationId, fixture.creator.account.address, true, { allowanceHash: once })
    const result = await boot().execute({ agentId: 'creator-agent', boardId: 'public', operationKey: 'hire-over', tool: 'create_task', args: offer('10', 'Executor second') })
    expect(result.status).toBe('confirmed')
    expect(await sdk.callsMade(ctx, once)).toBe(1n)
    expect(grants.get(allowanceHash)?.status).toBe('live')
    expect(agents.approval(third.operationId).status).toBe('executed')
  }, 180_000)

  it('constructs all three entries when an existing ERC20 approval makes the board omit it', async () => {
    const prepared = await board.createTask({ address: fixture.contributor.account.address }, offer('1', 'Executor preapproved'))
    const publish = prepared.transactions.at(-1)!
    const mapped = await mapAgentCalls(ctx, grants, { address: fixture.contributor.account.address, operator: fixture.creator.account.address }, [publish], now)
    expect(mapped.entries).toHaveLength(3)
    expect(decodeFunctionData({ abi: erc20Abi, data: mapped.entries[1]!.calls[0]!.data as Hex }).functionName).toBe('approve')
    expect(mapped.entries[0]!.grant).toBe(mapped.entries[2]!.grant)
  }, 120_000)

  it('requests operator approval before signing an exact one-call unstake', async () => {
    await sdk.delegate(ctx, fixture.worker, parseEther('10'))
    const input = { agentId: 'worker-agent', boardId: 'public', operationKey: 'unstake-one', tool: 'request_unstake', args: { amount: '1' } }
    const result = await boot().execute(input)
    expect(result.status).toBe('approval')
    if (result.status !== 'approval') throw new Error('Expected an unstake approval')
    const before = db.prepare('SELECT count(*) AS count FROM agent_sign_requests').get()
    expect(await boot().execute(input)).toEqual(result)
    expect(db.prepare('SELECT count(*) AS count FROM agent_sign_requests').get()).toEqual(before)
    agents.decide(result.operationId, fixture.creator.account.address, true, {})
    expect((await boot().execute(input)).status).toBe('confirmed')
    expect((await sdk.getPosition(ctx, fixture.worker.account.address, fixture.worker.account.address)).queued).toBe(parseEther('1'))
    const row = grants.list(fixture.worker.account.address).find(item => item.kind === 'unstake')!
    expect(await sdk.callsMade(ctx, row.delegation_hash)).toBe(1n)
  }, 120_000)

  it('returns pending honestly and reconciles the original send before any new signature after reconstruction', async () => {
    const input = { agentId: 'creator-agent', boardId: 'public', operationKey: 'pending-hire', tool: 'create_task', args: offer('1', 'Pending fixture hire') }
    await fixture.rpc('evm_setAutomine', [false])
    let result
    try {
      result = await boot().execute(input)
      expect(result.status).toBe('pending')
      const signatures = db.prepare('SELECT count(*) AS count FROM agent_sign_requests').get()
      const nonce = await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address, blockTag: 'pending' })
      await fixture.rpc('evm_mine')
      expect((await boot().execute(input)).status).toBe('confirmed')
      expect(db.prepare('SELECT count(*) AS count FROM agent_sign_requests').get()).toEqual(signatures)
      expect(await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address, blockTag: 'pending' })).toBe(nonce)
      expect(db.prepare('SELECT count(*) AS count FROM sponsor_operations WHERE action_key=?').get('pending-hire')).toEqual({ count: 1 })
    } finally {
      await fixture.rpc('evm_setAutomine', [true])
    }
  }, 120_000)

  it('renews fully expired gas grants from one frozen request without touching the spending allowance', async () => {
    const old = grants.list(fixture.contributor.account.address).filter(row => row.kind === 'agent-work' || row.kind === 'agent-approve' || row.kind === 'agent-sweep')
    await fixture.rpc('evm_setNextBlockTimestamp', [now + 2 * 86400])
    await fixture.rpc('evm_mine')
    now = Number((await ctx.publicClient.getBlock()).timestamp)
    const operation = agents.begin('creator-agent', 'renew-expired', 'public', 'renew', {})
    await ensureAgentGrants(ctx, agents, grants, signing, 'creator-agent', operation.id, now)
    const refreshed = grants.list(fixture.contributor.account.address).filter(row => row.status === 'live')
    expect(refreshed).toHaveLength(4) // three gas grants plus the already-used one-off approval
    expect(old.every(row => grants.get(row.delegation_hash)?.status === 'revoked')).toBe(true)
    const count = db.prepare('SELECT count(*) AS count FROM agent_sign_requests').get()
    await ensureAgentGrants(ctx, agents, grants, signing, 'creator-agent', operation.id, now)
    expect(db.prepare('SELECT count(*) AS count FROM agent_sign_requests').get()).toEqual(count)
    expect(grants.get(allowanceHash)).toMatchObject({ status: 'live', expires_at: now - 2 * 86400 + sdk.ALLOWANCE_VALIDITY })
  }, 120_000)

  it('returns an expired approved unsent hire to review and preserves its operation and publish bytes', async () => {
    const lifecycle = new AgentLifecycle({ sql: fromNodeSqlite(db), context: ctx, now: () => now, sponsor: bootSponsor() })
    const input = { agentId: 'creator-agent', boardId: 'public', operationKey: 'expired-approved-hire', tool: 'create_task', args: offer('30', 'Expired approval fixture') }
    const waiting = await boot().execute(input)
    expect(waiting.status).toBe('approval')
    const prepared = lifecycle.prepareApproval(waiting.operationId, fixture.creator.account.address)
    if (!('hash' in prepared)) throw new Error('Expected an exact hire allowance')
    await lifecycle.decideApproval(waiting.operationId, fixture.creator.account.address, true, await sdk.signTypedDataJson(fixture.creator, prepared.typedData))
    const frozen = agents.step(waiting.operationId, 'action')
    const nonce = await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })
    await fixture.rpc('evm_setNextBlockTimestamp', [now + sdk.ONE_OFF_VALIDITY + 1])
    await fixture.rpc('evm_mine')
    now = Number((await ctx.publicClient.getBlock()).timestamp)
    const retried = await boot().execute(input)
    expect(retried.status).toBe('approval')
    expect(agents.approval(waiting.operationId).status).toBe('pending')
    expect(await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })).toBe(nonce)
    const renewed = lifecycle.prepareApproval(waiting.operationId, fixture.creator.account.address)
    if (!('hash' in renewed)) throw new Error('Expected a fresh exact allowance')
    expect(renewed.hash).not.toBe(prepared.hash)
    await expect(lifecycle.decideApproval(waiting.operationId, fixture.creator.account.address, true, await sdk.signTypedDataJson(fixture.creator, prepared.typedData))).rejects.toThrow()
    await lifecycle.decideApproval(waiting.operationId, fixture.creator.account.address, true, await sdk.signTypedDataJson(fixture.creator, renewed.typedData))
    expect((await boot().execute(input)).status).toBe('confirmed')
    expect(agents.step(waiting.operationId, 'action')).toEqual(frozen)
    expect(await sdk.callsMade(ctx, renewed.hash)).toBe(1n)
    expect(await sdk.callsMade(ctx, prepared.hash)).toBe(0n)
    expect(agents.step(waiting.operationId, `operator-decision:${prepared.hash}`)).toBeDefined()
  }, 180_000)

  it('replaces expired signed and prepared gas renewal attempts under the same unsent operation', async () => {
    const operation = agents.begin('creator-agent', 'interrupted-renewal', 'public', 'renew', {})
    const original = [] as Hex[]
    for (const [index, kind] of (['agent-work', 'agent-approve', 'agent-sweep'] as const).entries()) {
      const base = { delegator: fixture.contributor.account.address, start: now, salt: BigInt(index + 500) }
      const spec: sdk.GrantSpec = kind === 'agent-sweep' ? { ...base, kind, operator: fixture.creator.account.address } : { ...base, kind }
      const prepared = grants.prepare(fixture.creator.account.address, spec)
      if (kind === 'agent-work') await grants.confirm(prepared.hash, await sdk.signTypedDataJson(fixture.contributor, prepared.typedData))
      agents.freezeStep(operation.id, `renew:${kind}:1`, { hash: prepared.hash, replaces: null })
      original.push(prepared.hash)
    }
    const prior = original.map(hash => grants.get(hash))
    const allowance = grants.get(allowanceHash)
    await fixture.rpc('evm_setNextBlockTimestamp', [now + sdk.GRANT_VALIDITY + 1])
    await fixture.rpc('evm_mine')
    now = Number((await ctx.publicClient.getBlock()).timestamp)
    const nonce = await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })
    await ensureAgentGrants(ctx, agents, grants, signing, 'creator-agent', operation.id, now)
    for (const [index, kind] of (['agent-work', 'agent-approve', 'agent-sweep'] as const).entries()) {
      const replacement = agents.step<{ hash: Hex }>(operation.id, `renew:${kind}:2`)!
      expect(replacement.hash).not.toBe(original[index])
      expect(grants.get(replacement.hash)).toMatchObject({ status: 'live', expires_at: now + sdk.GRANT_VALIDITY })
      expect(grants.get(original[index]!)).toMatchObject({ delegation_json: prior[index]!.delegation_json, signature: prior[index]!.signature })
      expect(agents.step(operation.id, `renew:${kind}:1`)).toEqual({ hash: original[index], replaces: null })
    }
    const signatures = db.prepare('SELECT count(*) AS count FROM agent_sign_requests').get()
    await ensureAgentGrants(ctx, agents, grants, signing, 'creator-agent', operation.id, now)
    expect(db.prepare('SELECT count(*) AS count FROM agent_sign_requests').get()).toEqual(signatures)
    expect(grants.get(allowanceHash)).toEqual(allowance)
    expect(await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })).toBe(nonce)
  }, 180_000)

  it('remaps an unsent frozen hire after gas authority expires and produces one economic send', async () => {
    const input = { agentId: 'creator-agent', boardId: 'public', operationKey: 'unsent-expired-mapping', tool: 'create_task',
      args: { ...offer('1', 'Frozen mapping fixture'), deliveryDeadline: now + 7 * 86400 } }
    const operation = agents.begin(input.agentId, input.operationKey, input.boardId, input.tool, input.args)
    const relay = fixture.admin.account.address
    const balance = await ctx.publicClient.getBalance({ address: relay })
    const nonce = await ctx.publicClient.getTransactionCount({ address: relay })
    await fixture.rpc('anvil_setBalance', [relay, '0x0'])
    try {
      await expect(boot().execute(input)).rejects.toThrow()
    } finally {
      await fixture.rpc('anvil_setBalance', [relay, `0x${balance.toString(16)}`])
    }
    const frozen = agents.step(operation.id, 'action')
    const originalMappingStep = agents.step(operation.id, 'entries:1') === undefined ? 'entries' : 'entries:1'
    const mapping = agents.step(operation.id, originalMappingStep)
    expect(frozen).toBeDefined()
    expect(mapping).toBeDefined()
    expect(agents.operation(operation.id).sponsor_operation_id).toBeNull()
    expect(await ctx.publicClient.getTransactionCount({ address: relay })).toBe(nonce)
    const allowance = grants.get(allowanceHash)
    await fixture.rpc('evm_setNextBlockTimestamp', [now + sdk.GRANT_VALIDITY + 1])
    await fixture.rpc('evm_mine')
    now = Number((await ctx.publicClient.getBlock()).timestamp)
    const result = await boot().execute(input)
    expect(result.status).toBe('confirmed')
    expect(agents.step(operation.id, 'action')).toEqual(frozen)
    expect(agents.step(operation.id, originalMappingStep)).toEqual(mapping)
    expect(agents.step(operation.id, 'entries:2')).not.toEqual(mapping)
    expect(grants.get(allowanceHash)).toEqual(allowance)
    expect(db.prepare('SELECT count(*) AS count FROM sponsor_operations WHERE action_key=?').get(input.operationKey)).toEqual({ count: 1 })
    expect(await ctx.publicClient.getTransactionCount({ address: relay })).toBe(nonce + 1)
    const signatures = db.prepare('SELECT count(*) AS count FROM agent_sign_requests').get()
    expect(await boot().execute(input)).toEqual(result)
    expect(db.prepare('SELECT count(*) AS count FROM agent_sign_requests').get()).toEqual(signatures)
    expect(await ctx.publicClient.getTransactionCount({ address: relay })).toBe(nonce + 1)
  }, 180_000)
})
