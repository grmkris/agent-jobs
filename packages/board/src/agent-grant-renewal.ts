/** Lazy gas-grant renewal cannot refresh an operator spending allowance. */
import * as sdk from '@agent-jobs/sdk'
import { type Hex, keccak256, stringToHex } from 'viem'
import { AgentStore } from './agents.ts'
import { AgentSigning } from './agent-signing.ts'
import { GrantStore, grantSpecJson } from './grants.ts'

const kinds = ['agent-work', 'agent-approve', 'agent-sweep'] as const

export async function ensureAgentGrants(ctx: sdk.Ctx, agents: AgentStore, grants: GrantStore, signing: AgentSigning, agentId: string, operationId: Hex, now: number): Promise<void> {
  const agent = agents.get(agentId)
  if (agent.address === null || agent.state === 'revoked') throw new Error('Agent is unavailable for renewal')
  for (const kind of kinds) {
    const step = `renew:${kind}`
    const saved = agents.step<{ hash: Hex; replaces: Hex | null }>(operationId, step)
    if (saved === undefined) {
      const current = grants.list(agent.address).find(row => row.kind === kind && row.status === 'live' && row.owner.toLowerCase() === agent.operator.toLowerCase())
      if (current !== undefined && current.expires_at > now + 3600 && !await sdk.isDisabled(ctx, current.delegation_hash)
        && await sdk.callsMade(ctx, current.delegation_hash) < BigInt(sdk.GRANT_CALLS - 8)) continue
      const base = { delegator: agent.address, start: now, salt: BigInt(keccak256(stringToHex(JSON.stringify([agentId, operationId, kind])))) }
      const spec: sdk.GrantSpec = kind === 'agent-sweep' ? { ...base, kind, operator: agent.operator } : { ...base, kind }
      const prepared = grants.prepare(agent.operator, spec)
      agents.freezeStep(operationId, step, { spec: grantSpecJson(spec), hash: prepared.hash, replaces: current?.delegation_hash ?? null })
    }
    const request = agents.step<{ hash: Hex; replaces: Hex | null }>(operationId, step)!
    const row = grants.get(request.hash)!
    if (row.status === 'prepared') await grants.confirm(request.hash, await signing.signGrant(agentId, request.hash))
    if (grants.get(request.hash)?.status !== 'live' || row.expires_at <= now) throw new Error('Persisted gas-grant renewal is no longer usable')
    if (request.replaces !== null && request.replaces !== request.hash) grants.stop(request.replaces)
  }
}
