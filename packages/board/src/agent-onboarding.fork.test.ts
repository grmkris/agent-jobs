/** Local ECDSA authority, SQLite reconstruction and the deployed registry/delegation contracts on a Monad fork. */
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as sdk from '@agent-jobs/sdk'
import { type LocalAccount } from 'viem'
import { forkEnabled, forkSetupTimeout, startHirelingFork } from '../../sdk/test/hireling-fixture.ts'
import { fromNodeSqlite } from './store.ts'
import { AgentLifecycle } from './agent-lifecycle.ts'
import { GrantStore } from './grants.ts'
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

  function lifecycle() {
    const sql = fromNodeSqlite(db)
    const sponsor = new SponsorDesk({ sql, ctx, now: () => now, relay: { account: fixture.admin.account as LocalAccount, rpcUrl: fixture.url }, fail: (code, message) => new BoardError(code, message) })
    return new AgentLifecycle({ sql, context: ctx, now: () => now, sponsor })
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

  it('disables the old allowance before replacement, then stops OAuth and disables every known agent grant', async () => {
    const operator = fixture.creator.account.address
    const sponsor = lifecycle().deps.sponsor
    const gas = await sponsor.prepare(operator)
    await sponsor.confirm(operator, await sdk.signTypedDataJson(fixture.creator, gas.sign.typedData))
    const token = ctx.deployment.rewardTokens[0]!
    const first = lifecycle().prepareAllowance('onboarding-fork', operator, { key: 'first-allowance', token, amount: 25n })
    await lifecycle().confirmAllowance('onboarding-fork', operator, 'first-allowance', first.hash, await sdk.signTypedDataJson(fixture.creator, first.typedData))
    const replacement = lifecycle().prepareAllowance('onboarding-fork', operator, { key: 'replace-allowance', token, amount: 30n })
    await expect(lifecycle().confirmAllowance('onboarding-fork', operator, 'replace-allowance', replacement.hash, await sdk.signTypedDataJson(fixture.worker, replacement.typedData))).rejects.toThrow('not the delegator')
    expect(await sdk.isDisabled(ctx, first.hash)).toBe(false)
    expect(new GrantStore(fromNodeSqlite(db), ctx).get(replacement.hash)!.status).toBe('prepared')
    await lifecycle().confirmAllowance('onboarding-fork', operator, 'replace-allowance', replacement.hash, await sdk.signTypedDataJson(fixture.creator, replacement.typedData))
    expect(await sdk.isDisabled(ctx, first.hash)).toBe(true)
    expect(new GrantStore(fromNodeSqlite(db), ctx).get(first.hash)!.status).toBe('disabled')
    const sql = fromNodeSqlite(db)
    sql.run("INSERT INTO agent_oauth_families (id,client_id,agent_id,board_id,scopes_json,resource,created_at) VALUES ('revoke-fixture','fixture-client','onboarding-fork','public','[]','https://fixture.test/mcp',?)", now)
    lifecycle().stopAccess('onboarding-fork', operator)
    expect(agents.get('onboarding-fork').state).toBe('revoked')
    expect(sql.all<{ revoked_at: number }>("SELECT revoked_at FROM agent_oauth_families WHERE id='revoke-fixture'")[0]!.revoked_at).toBe(now)
    await expect(lifecycle().confirmAllowance('onboarding-fork', operator, 'replace-allowance', replacement.hash, await sdk.signTypedDataJson(fixture.creator, replacement.typedData))).rejects.toThrow('access has stopped')
    const sweep = new GrantStore(sql, ctx).list(fixture.worker.account.address).find(row => row.kind === 'agent-sweep')!
    await expect(sponsor.submit(fixture.worker.account.address, [{ grant: sweep.delegation_hash, calls: [{ to: token, data: sdk.advanceExecution(token, operator, 1n).callData }] }], 'revoked-sweep')).rejects.toThrow('live bound agent')
    const result = await lifecycle().revoke('onboarding-fork', operator)
    expect(result.revocation.onchainPermissionsDisabled).toBe(true)
    for (const grant of new GrantStore(sql, ctx).list(fixture.worker.account.address)) expect(await sdk.isDisabled(ctx, grant.delegation_hash)).toBe(true)
    expect(await sdk.isDisabled(ctx, replacement.hash)).toBe(true)
    const nonce = await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })
    await lifecycle().revoke('onboarding-fork', operator)
    expect(await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })).toBe(nonce)
  })
})
