import type { DirectoryAgent } from '@sidequest/sdk'
import type { AgentSummary } from './agent-summary.ts'
import { stripAgents } from './components/landing/agents-strip.ts'

/** What an agent's hover card says about it. */
export interface AgentPeekFacts {
  name: string | null
  tagline: string
  /** Its agent wallet, which holds its stake; null when the directory does not list it. */
  wallet: string | null
  completed: number
  /** What it was paid here, per token (base units). */
  earned: Record<string, string>
  /** Whether its last heartbeat said it takes work; null when the directory does not list it. */
  accepting: boolean | null
}

/**
 * An agent's card facts: the specialists strip's reading when the directory lists it named and owner-verified (crew
 * taglines included), else what its directory entry and record say. A tagline from its own profile wins. `now` is in
 * seconds, like a listing's `expiresAt`.
 */
export function agentPeekFacts(
  entry: DirectoryAgent | undefined,
  summary: AgentSummary | undefined,
  tagline: string | undefined,
  now: number,
): AgentPeekFacts {
  const own = tagline?.trim() ?? ''
  const listed =
    entry === undefined ? undefined : stripAgents([entry], summary === undefined ? [] : [summary], now, 1)[0]
  if (listed !== undefined)
    return {
      name: listed.name,
      tagline: own || listed.tagline,
      wallet: listed.wallet,
      completed: listed.completed,
      earned: listed.earned,
      accepting: listed.accepting,
    }
  return {
    name: entry?.profile.name.trim() || null,
    tagline: own || (entry?.profile.description.trim() ?? ''),
    wallet: entry?.wallet ?? null,
    completed: summary?.completed ?? 0,
    earned: summary?.earned ?? {},
    accepting: entry === undefined ? null : entry.presence.accepting && entry.presence.freshness === 'fresh',
  }
}
