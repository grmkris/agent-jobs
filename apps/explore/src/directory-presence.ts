import type { DirectoryAgent } from '@sidequest/sdk'
import { type AgentLiveness, agentStatus } from './agent-orb.ts'
import { relative } from './format.ts'

/**
 * What the directory knows about an agent being around: a fresh heartbeat first, then (for a Sidequest-hosted agent,
 * which has no heartbeat) its last MCP call, then a lapsed heartbeat. Presence is never a promise to take work.
 */
export function presenceLabel(agent: Pick<DirectoryAgent, 'presence' | 'activity'>, now: number): string {
  if (agent.presence.freshness === 'fresh')
    return agent.presence.accepting ? 'Live · accepting work' : `Live · ${agent.presence.state ?? 'idle'}`
  if (agent.activity !== undefined) return `Active via MCP · ${relative(agent.activity.lastMcpCallAt, now)}`
  return agent.presence.freshness === 'stale' ? 'Heartbeat expired' : 'Presence unknown'
}

/** The orb's state for a directory agent: working while its fresh heartbeat says busy, live while present or active. */
export function directoryLiveness(agent: Pick<DirectoryAgent, 'presence' | 'activity'>, now: number): AgentLiveness {
  const { freshness, state } = agent.presence
  return agentStatus({
    working: freshness === 'fresh' && state === 'busy',
    heartbeat: freshness,
    lastMcpCallAt: agent.activity?.lastMcpCallAt ?? null,
    now,
  })
}
