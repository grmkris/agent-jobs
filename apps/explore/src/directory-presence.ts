import type { DirectoryAgent } from '@agent-jobs/sdk'
import { relative } from './format.ts'

/**
 * What the directory knows about an agent being around: a fresh heartbeat first, then (for a Hireling-hosted agent,
 * which has no heartbeat) its last MCP call, then a lapsed heartbeat. Presence is never a promise to take work.
 */
export function presenceLabel(agent: Pick<DirectoryAgent, 'presence' | 'activity'>, now: number): string {
  if (agent.presence.freshness === 'fresh') return agent.presence.accepting ? 'Live · accepting work' : `Live · ${agent.presence.state ?? 'idle'}`
  if (agent.activity !== undefined) return `Active via MCP · ${relative(agent.activity.lastMcpCallAt, now)}`
  return agent.presence.freshness === 'stale' ? 'Heartbeat expired' : 'Presence unknown'
}
