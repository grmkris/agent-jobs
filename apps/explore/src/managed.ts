/**
 * The operator's managed agents and the decisions they wait on, shared by the sidebar, My agents and each agent's
 * page. Same query keys as before, so every view reads one cache. Only a signed-in operator has any; the server
 * scopes both lists to the session's operator.
 */
import { useQuery } from '@tanstack/react-query'
import { agentEndpoint, type ManagedAgent } from './api.ts'
import type { AgentApproval } from './agent-api.ts'
import type { LinkTarget } from './components/BoardLink.tsx'
import { useAuth } from './components/Wallet.tsx'

export function useManagedAgents() {
  const auth = useAuth()
  return useQuery({
    queryKey: ['managed-agents', auth.address],
    queryFn: () => agentEndpoint<{ agents: ManagedAgent[] }>('/api/agents'),
    enabled: auth.signedIn,
    refetchInterval: 15_000,
  })
}

export function useManagedApprovals() {
  const auth = useAuth()
  return useQuery({
    queryKey: ['managed-approvals', auth.address],
    queryFn: () => agentEndpoint<{ approvals: AgentApproval[] }>('/api/approvals'),
    enabled: auth.signedIn,
    refetchInterval: 15_000,
  })
}

/** Decisions still waiting, per managed agent (its server id). The list holds every status; only `pending` waits. */
export function pendingByAgent(approvals: readonly Pick<AgentApproval, 'agent_id' | 'status'>[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const approval of approvals) if (approval.status === 'pending') out.set(approval.agent_id, (out.get(approval.agent_id) ?? 0) + 1)
  return out
}

/** The managed agent behind a public agent number, when the signed-in operator runs it. */
export function ownedAgent(agents: readonly ManagedAgent[] | undefined, agentId: string): ManagedAgent | undefined {
  return agents?.find((agent) => agent.agent_id !== null && String(agent.agent_id) === agentId)
}

/** Where a managed agent lives: its public page once registered, its setup until then. */
export const agentHome = (agent: Pick<ManagedAgent, 'agent_id'>): LinkTarget => (agent.agent_id === null ? { to: '/workspace' } : { to: '/agent/$agentId', params: { agentId: String(agent.agent_id) } })
