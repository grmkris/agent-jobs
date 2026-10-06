import type { Address } from 'viem'
import type { ManagedAgent } from '../api.ts'
import { BackingManager } from './BackingManager.tsx'

/** Agent setup and OAuth use the same owned-position flow as the profile. */
export function AgentStake({ agent, operator }: { agent: ManagedAgent; operator: string }) {
  if (agent.address === null || agent.agent_id === null) return <p className="text-sm text-muted-foreground">Register the agent before backing it.</p>
  return <BackingManager owner={operator as Address} scope={{ kind: 'agent', account: agent.address as Address, agentId: agent.agent_id }} />
}
