/** Local ECDSA authority, SQLite reconstruction and the deployed registry/delegation contracts on a Monad fork. */
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as sdk from '@agent-jobs/sdk'
import { type LocalAccount } from 'viem'
import { forkEnabled, forkSetupTimeout, startHirelingFork } from '../../sdk/test/hireling-fixture.ts'
import { fromNodeSqlite } from './store.ts'
import { AgentStore } from './agents.ts'
import { AgentOnboarding } from './agent-onboarding.ts'
import { AgentSigning } from './agent-signing.ts'
import { RelaySender } from './relay.ts'
import { SponsorDesk } from './sponsor.ts'
import { BoardError } from './service.ts'

const suite = forkEnabled ? describe : describe.skip
suite('resumable agent registry onboarding', () => {
  let fixture: Awaited<ReturnType<typeof startHirelingFork>>
  let db: DatabaseSync
  let ctx: sdk.Ctx
  let agents: AgentStore
  let now: number

  function boot() {
    const sql = fromNodeSqlite(db)
    const signing = new AgentSigning(sql, ctx, {
      signTypedData: (_id, data) => sdk.signTypedDataJson(fixture.worker, data),
      signAuthorization: (_id, contract, chainId, nonce) => fixture.worker.signAuthorization({ contractAddress: contract, chainId, nonce, executor: fixture.admin.account.address }),
    }, () => now)
    return new AgentOnboarding({ sql, context: ctx, now: () => now, signing, signerId: 'unused-in-fork', policyId: 'unused-in-fork',
      relay: new RelaySender(sql, ctx, fixture.admin.account as LocalAccount, fixture.url, () => now),
      sponsor: new SponsorDesk({ sql, ctx, now: () => now, relay: { account: fixture.admin.account as LocalAccount, rpcUrl: fixture.url }, fail: (code, message) => new BoardError(code, message) }),
    })
  }

  beforeAll(async () => {
    fixture = await startHirelingFork()
    ctx = { ...fixture.ctx, deployment: { ...fixture.ctx.deployment, relay: fixture.admin.account.address } }
    now = Number((await ctx.publicClient.getBlock()).timestamp)
    db = new DatabaseSync(':memory:')
    agents = new AgentStore(fromNodeSqlite(db), () => now)
    agents.create({ id: 'onboarding-fork', operator: fixture.creator.account.address, privyUserId: 'did:privy:local-ecdsa-fixture', name: 'Registry fixture', registry: ctx.deployment.identity, chainId: ctx.deployment.chainId })
    agents.bindWallet('onboarding-fork', 'local-ecdsa-wallet', fixture.worker.account.address)
    const authorization = await fixture.creator.signAuthorization({ contractAddress: ctx.deployment.delegation.delegator, executor: fixture.admin.account.address })
    expect((await ctx.publicClient.waitForTransactionReceipt({ hash: await fixture.admin.sendTransaction({ to: fixture.creator.account.address, data: '0x', authorizationList: [authorization] }) })).status).toBe('success')
  }, forkSetupTimeout())

  afterAll(() => { db?.close(); fixture?.close() })

  it('upgrades, issues separate grants, registers to the operator and binds the agent wallet exactly once', async () => {
    const ready = await boot().resume('onboarding-fork')
    expect(ready.state).toBe('grants-live')
    const nonce = await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })
    expect((await boot().resume('onboarding-fork')).state).toBe('grants-live')
    expect(await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })).toBe(nonce)
    const expired = await boot().prepareRegistration('onboarding-fork', fixture.creator.account.address)
    now += sdk.ONE_OFF_VALIDITY + 1
    await fixture.rpc('evm_setNextBlockTimestamp', [now])
    await fixture.rpc('evm_mine', [])
    const request = await boot().prepareRegistration('onboarding-fork', fixture.creator.account.address)
    expect(request.hash).not.toBe(expired.hash)
    const signature = await sdk.signTypedDataJson(fixture.creator, request.typedData)
    const result = await boot().register('onboarding-fork', fixture.creator.account.address, request.hash, signature)
    expect('state' in result ? result.state : result.status).toBe('active')
    const agent = agents.get('onboarding-fork')
    expect(agent.agent_id).not.toBeNull()
    expect((await ctx.publicClient.readContract({ address: agent.registry, abi: sdk.identityAbi, functionName: 'ownerOf', args: [BigInt(agent.agent_id!)] })).toLowerCase()).toBe(fixture.creator.account.address.toLowerCase())
    expect((await sdk.agentWallet(ctx, BigInt(agent.agent_id!))).toLowerCase()).toBe(fixture.worker.account.address.toLowerCase())
    const after = await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })
    expect((await boot().register('onboarding-fork', fixture.creator.account.address, request.hash, signature) as { state: string }).state).toBe('active')
    expect(await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })).toBe(after)
    // A crash after the binding receipt but before the state update must finish even after expiry.
    fromNodeSqlite(db).run("UPDATE agents SET state='registered' WHERE id='onboarding-fork'")
    now += sdk.ONE_OFF_VALIDITY + 1
    await fixture.rpc('evm_setNextBlockTimestamp', [now])
    await fixture.rpc('evm_mine', [])
    expect((await boot().register('onboarding-fork', fixture.creator.account.address, request.hash, signature) as { state: string }).state).toBe('active')
    expect(await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })).toBe(after)
  })
})
