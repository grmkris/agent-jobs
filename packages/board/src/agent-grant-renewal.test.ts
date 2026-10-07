import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import * as sdk from '@sidequest/sdk'
import { AgentSigning } from './agent-signing.ts'
import { AgentStore } from './agents.ts'
import { ensureAgentGrants } from './agent-grant-renewal.ts'
import { GrantStore } from './grants.ts'
import { fromNodeSqlite } from './store.ts'

describe('deployment-aware agent grant renewal', () => {
  it('renews stale gas grants while retaining an allowance grant', async () => {
    const db = new DatabaseSync(':memory:')
    const sql = fromNodeSqlite(db)
    const oldDeployment = sdk.deployment('monad-testnet')
    const oldCtx = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
    const operator = privateKeyToAccount(`0x${'11'.repeat(32)}`)
    const agent = privateKeyToAccount(`0x${'22'.repeat(32)}`)
    const now = 1_800_000_000
    const agents = new AgentStore(sql, () => now)
    agents.create({
      id: 'cutover-agent',
      operator: operator.address,
      privyUserId: 'did:privy:cutover',
      name: 'Cutover',
      registry: oldDeployment.identity,
      chainId: oldDeployment.chainId,
    })
    agents.bindWallet('cutover-agent', 'cutover-wallet', agent.address)
    for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const)
      agents.advance('cutover-agent', state)
    const oldGrants = new GrantStore(sql, oldCtx)
    const allowance = oldGrants.prepare(operator.address, {
      kind: 'allowance',
      delegator: operator.address,
      agent: agent.address,
      token: oldDeployment.rewardTokens[0]!,
      amount: 20n,
      salt: 1n,
      start: now,
    })
    await oldGrants.confirm(allowance.hash, await operator.signTypedData(JSON.parse(allowance.typedData)))
    const oldHashes: Hex[] = []
    for (const [index, kind] of (['agent-work', 'agent-approve', 'agent-sweep'] as const).entries()) {
      const base = { delegator: agent.address, start: now, salt: BigInt(index + 2) }
      const spec: sdk.GrantSpec =
        kind === 'agent-sweep' ? { ...base, kind, operator: operator.address } : { ...base, kind }
      const prepared = oldGrants.prepare(operator.address, spec)
      await oldGrants.confirm(prepared.hash, await agent.signTypedData(JSON.parse(prepared.typedData)))
      oldHashes.push(prepared.hash)
    }
    const changedDeployment: sdk.Deployment = {
      ...oldDeployment,
      core: `0x${'44'.repeat(20)}`,
      factory: `0x${'55'.repeat(20)}`,
      sidequest: { ...oldDeployment.sidequest!, vault: `0x${'66'.repeat(20)}` },
      stacks: {
        main: {
          ...sdk.stack(oldDeployment, 'main'),
          holding: `0x${'77'.repeat(20)}`,
          evaluator: `0x${'88'.repeat(20)}`,
        },
      },
    }
    const ctx = { ...oldCtx, deployment: changedDeployment, stack: sdk.stack(changedDeployment, 'main') }
    vi.spyOn(ctx.publicClient, 'readContract').mockImplementation(async (request) =>
      request.functionName === 'disabledDelegations' ? false : 0n,
    )
    const grants = new GrantStore(sql, ctx)
    const operation = agents.begin('cutover-agent', 'renew-cutover', 'public', 'renew', {})
    const signTypedData = vi.fn(async (_walletId: string, typedData: string) =>
      agent.signTypedData(JSON.parse(typedData)),
    )
    const signing = new AgentSigning(
      sql,
      ctx,
      {
        signTypedData,
        signAuthorization: async () => {
          throw new Error('Unexpected authorization')
        },
      },
      () => now,
    )
    await ensureAgentGrants(ctx, agents, grants, signing, 'cutover-agent', operation.id, now)
    for (const hash of oldHashes) expect(grants.get(hash)?.status).toBe('revoked')
    expect(grants.get(allowance.hash)?.status).toBe('live')
    expect(
      grants.list(agent.address).filter((row) => row.status === 'live' && row.kind.startsWith('agent-')),
    ).toHaveLength(3)
    expect(signTypedData).toHaveBeenCalledTimes(3)
    const allowanceRow = grants.get(allowance.hash)
    await ensureAgentGrants(ctx, agents, grants, signing, 'cutover-agent', operation.id, now)
    expect(signTypedData).toHaveBeenCalledTimes(3)
    expect(grants.get(allowance.hash)).toEqual(allowanceRow)
    const priorStep = agents.step(operation.id, 'renew:agent-work:1')
    const prepared = grants.prepare(operator.address, {
      kind: 'agent-work',
      delegator: agent.address,
      salt: 99n,
      start: now,
    })
    agents.freezeStep(operation.id, 'renew:agent-work:2', { hash: prepared.hash, replaces: null })
    const anotherDeployment: sdk.Deployment = { ...changedDeployment, core: `0x${'99'.repeat(20)}` }
    const nextCtx = { ...ctx, deployment: anotherDeployment }
    const nextGrants = new GrantStore(sql, nextCtx)
    const nextSigning = new AgentSigning(
      sql,
      nextCtx,
      {
        signTypedData,
        signAuthorization: async () => {
          throw new Error('Unexpected authorization')
        },
      },
      () => now,
    )
    await ensureAgentGrants(nextCtx, agents, nextGrants, nextSigning, 'cutover-agent', operation.id, now)
    expect(agents.step(operation.id, 'renew:agent-work:1')).toEqual(priorStep)
    expect(nextGrants.get(prepared.hash)?.status).toBe('prepared')
    const freshStep = agents.step<{ hash: Hex }>(operation.id, 'renew:agent-work:3')!
    expect(nextGrants.matchesDeployment(freshStep.hash)).toBe(true)
    expect(signTypedData).toHaveBeenCalledTimes(4)
    expect(nextGrants.get(allowance.hash)).toEqual(allowanceRow)
    sql.run("UPDATE agent_operations SET stage='sending' WHERE id=?", operation.id)
    await expect(
      ensureAgentGrants(nextCtx, agents, nextGrants, nextSigning, 'cutover-agent', operation.id, now),
    ).rejects.toThrow('Reconcile the original send')
    vi.restoreAllMocks()
    db.close()
  })
})
