/** Lazy gas-grant renewal cannot refresh an operator spending allowance. */
import * as sdk from '@sidequest/sdk'
import { type Hex, keccak256, stringToHex } from 'viem'
import { AgentStore } from './agents.ts'
import { AgentSigning } from './agent-signing.ts'
import { GrantStore, grantSpecJson } from './grants.ts'

const kinds = ['agent-work', 'agent-approve', 'agent-sweep'] as const

export async function ensureAgentGrants(
  ctx: sdk.Ctx,
  agents: AgentStore,
  grants: GrantStore,
  signing: AgentSigning,
  agentId: string,
  operationId: Hex,
  now: number,
): Promise<void> {
  const agent = agents.get(agentId)
  if (agent.address === null || agent.state === 'revoked') throw new Error('Agent is unavailable for renewal')
  const operation = agents.operation(operationId)
  if (operation.sponsor_operation_id !== null || operation.stage === 'sending')
    throw new Error('Reconcile the original send before renewing its gas grants')
  for (const kind of kinds) {
    const prefix = `renew:${kind}:`
    const prior = agents.sql
      .all<{ name: string; value_json: string }>(
        'SELECT name,value_json FROM agent_operation_steps WHERE operation_id=? AND substr(name,1,?)=?',
        operationId,
        prefix.length,
        prefix,
      )
      .filter((step) => /^renew:.+:[1-9][0-9]*$/.test(step.name))
      .toSorted((a, b) => Number(b.name.slice(prefix.length)) - Number(a.name.slice(prefix.length)))[0]
    const saved =
      prior === undefined ? undefined : (JSON.parse(prior.value_json) as { hash: Hex; replaces: Hex | null })
    const savedRow = saved === undefined ? undefined : grants.get(saved.hash)
    const current = grants
      .list(agent.address)
      .find(
        (row) => row.kind === kind && row.status === 'live' && row.owner.toLowerCase() === agent.operator.toLowerCase(),
      )
    if (
      current !== undefined &&
      current.expires_at > now + 3600 &&
      !(await sdk.isDisabled(ctx, current.delegation_hash)) &&
      (await sdk.callsMade(ctx, current.delegation_hash)) < BigInt(sdk.GRANT_CALLS - 8)
    ) {
      if (saved?.hash === current.delegation_hash && saved.replaces !== null && saved.replaces !== saved.hash)
        grants.stop(saved.replaces)
      continue
    }
    if (
      saved !== undefined &&
      savedRow !== undefined &&
      savedRow.status === 'prepared' &&
      savedRow.expires_at > now &&
      !(await sdk.isDisabled(ctx, saved.hash))
    ) {
      await grants.confirm(saved.hash, await signing.signGrant(agentId, saved.hash))
      if (saved.replaces !== null && saved.replaces !== saved.hash) grants.stop(saved.replaces)
      continue
    }
    if (
      saved !== undefined &&
      savedRow?.status === 'live' &&
      savedRow.expires_at > now &&
      !(await sdk.isDisabled(ctx, saved.hash)) &&
      (await sdk.callsMade(ctx, saved.hash)) < BigInt(sdk.GRANT_CALLS - 8)
    )
      continue
    const attempt = prior === undefined ? 1 : Number(prior.name.slice(prefix.length)) + 1
    const step = `${prefix}${attempt}`
    const base = {
      delegator: agent.address,
      start: now,
      salt: BigInt(keccak256(stringToHex(JSON.stringify([agentId, operationId, kind, attempt])))),
    }
    const spec: sdk.GrantSpec = kind === 'agent-sweep' ? { ...base, kind, operator: agent.operator } : { ...base, kind }
    const prepared = grants.prepare(agent.operator, spec)
    agents.freezeStep(operationId, step, {
      spec: grantSpecJson(spec),
      hash: prepared.hash,
      replaces: current?.delegation_hash ?? null,
    })
    await grants.confirm(prepared.hash, await signing.signGrant(agentId, prepared.hash))
    if (current !== undefined && current.delegation_hash !== prepared.hash) grants.stop(current.delegation_hash)
  }
}
