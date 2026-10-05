import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import * as sdk from '@agent-jobs/sdk'
import { GrantStore } from './grants.ts'
import { AgentStore } from './agents.ts'
import { fromNodeSqlite } from './store.ts'
import { encodeFunctionData } from 'viem'

const d = sdk.deployment('monad-testnet')
const ctx = { deployment: d, stack: sdk.stack(d, 'main') }
describe('agent grant store', () => {
  it('prepares exact unstaking authority only for the operator-approved operation', () => {
    const db = new DatabaseSync(':memory:')
    const sql = fromNodeSqlite(db)
    const now = 1_800_000_000
    const agents = new AgentStore(sql, () => now)
    const store = new GrantStore(sql, ctx)
    const operator = '0x1111111111111111111111111111111111111111'
    const agent = '0x2222222222222222222222222222222222222222'
    agents.create({ id: 'unstake-fixture', operator, privyUserId: 'did:privy:fixture', name: 'Fixture', registry: d.identity, chainId: d.chainId })
    agents.bindWallet('unstake-fixture', 'fixture-wallet', agent)
    const operation = agents.begin('unstake-fixture', 'unstake-one', 'public', 'request_unstake', { amount: '1' })
    const call = { to: d.hireling!.vault, data: encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'requestUnstake', args: [17n] }) }
    agents.requestApproval(operation, 'unstake', { amount: '17', call })
    const spec: sdk.GrantSpec = { kind: 'unstake', delegator: agent, amount: 17n, operationId: operation.id, start: now, salt: 9n }
    expect(() => store.prepare(operator, spec)).toThrow('verified operator decision')
    agents.decide(operation.id, operator, true, {})
    expect(store.prepare(operator, spec).description).toMatchObject({ amount: '17', calls: 1, expiresAt: now + 600 })
    expect(() => store.prepare(operator, { ...spec, amount: 18n })).toThrow('exact operator approval')
    expect(() => store.prepare(agent, spec)).toThrow('verified operator decision')
    db.close()
  })

  it('issues a one-off token approval only after the exact operation has a verified operator allowance', async () => {
    const db = new DatabaseSync(':memory:')
    const sql = fromNodeSqlite(db)
    const now = 1_800_000_000
    const agents = new AgentStore(sql, () => now)
    const store = new GrantStore(sql, ctx)
    const { privateKeyToAccount } = await import('viem/accounts')
    const operator = privateKeyToAccount(`0x${'11'.repeat(32)}`)
    const agent = privateKeyToAccount(`0x${'22'.repeat(32)}`)
    const token = '0x3333333333333333333333333333333333333333' as const
    agents.create({ id: 'unknown-hire', operator: operator.address, privyUserId: 'did:privy:fixture', name: 'Fixture', registry: d.identity, chainId: d.chainId })
    agents.bindWallet('unknown-hire', 'fixture-wallet', agent.address)
    const operation = agents.begin('unknown-hire', 'exact-hire', 'public', 'create_task', { token, reward: '17' })
    const publish = encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'publish', args: [{
      token, reward: 17n, approver: agent.address, arbitrator: operator.address, manifestHash: sdk.EMPTY_HASH, policyHash: sdk.EMPTY_HASH,
      creatorBond: 0n, workerBond: 0n, deliveryDeadline: now + 3600, expiredAt: now + 7200,
      reviewWindow: 3600, disputeWindow: 3600, arbitrationWindow: 43200,
    }] })
    agents.requestApproval(operation, 'hire-over-limit', { token, amount: '17', publish })
    const spec = { kind: 'agent-approve-once' as const, delegator: agent.address, token, amount: 17n, salt: 11n, start: now, operationId: operation.id }
    expect(() => store.prepare(operator.address, spec)).toThrow('verified operator decision')
    const allowance = store.prepare(operator.address, { kind: 'allowance-once', delegator: operator.address, agent: agent.address, token, amount: 17n, salt: 12n, start: now })
    agents.decide(operation.id, operator.address, true, { allowanceHash: allowance.hash })
    expect(() => store.prepare(operator.address, spec)).toThrow('verified exact operator allowance')
    await store.confirm(allowance.hash, await operator.signTypedData(JSON.parse(allowance.typedData)))
    const prepared = store.prepare(operator.address, spec)
    expect(prepared.description).toMatchObject({ token, amount: '17', calls: 1 })
    expect(() => store.prepare(operator.address, { ...spec, amount: 18n })).toThrow('approved hire')
    expect(() => store.prepare(operator.address, { ...spec, operationId: `0x${'00'.repeat(32)}` })).toThrow('verified operator decision')
    expect(() => store.prepare(agent.address, spec)).toThrow('verified operator decision')
    expect(() => store.approvedHire(operator.address, spec, `${publish}00`)).toThrow('frozen publish')
    db.close()
  })

  it('persists one immutable template, confirms its delegator signature, and survives restart', async () => {
    const db = new DatabaseSync(':memory:')
    const store = new GrantStore(fromNodeSqlite(db), ctx)
    const account = (await import('viem/accounts')).privateKeyToAccount(`0x${'11'.repeat(32)}`)
    const operator = account.address
    const spec = { kind: 'registration' as const, delegator: operator, salt: 9n, start: 1_800_000_000 }
    const prepared = store.prepare(operator, spec)
    const valid = await account.signTypedData(JSON.parse(prepared.typedData))
    const confirmed = await store.confirm(prepared.hash, valid)
    expect(confirmed).toMatchObject({ delegation_hash: prepared.hash, status: 'live', signature: valid })
    expect(store.signed(prepared.hash).signature).toBe(valid)
    const stranger = (await import('viem/accounts')).privateKeyToAccount(`0x${'22'.repeat(32)}`)
    await expect(store.confirm(prepared.hash, await stranger.signTypedData(JSON.parse(prepared.typedData)))).rejects.toThrow('not the delegator')
    expect(new GrantStore(fromNodeSqlite(db), ctx).signed(prepared.hash).signature).toBe(valid)
    store.stop(prepared.hash)
    expect(() => store.signed(prepared.hash)).toThrow('not live')
    db.close()
  })
})
