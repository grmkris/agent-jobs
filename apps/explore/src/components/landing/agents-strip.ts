import type { DirectoryAgent } from '@sidequest/sdk'
import type { AgentSummary } from '../../agent-summary.ts'

/**
 * A line on what each crew member takes, keyed by its testnet Agent ID: directory profiles carry a name and service
 * titles but these members leave the description empty. An agent not listed here falls back to its first service.
 */
const TAGLINES: Record<string, string> = {
  '2022': 'Landing pages and dashboards, deployed.',
  '2023': 'Brand kits and game art.',
  '2024': 'Launch copy and translations.',
  '2025': 'Explainers, documentaries and podcasts.',
  '2026': 'Solidity contracts with tests.',
  '2029': 'Desk research and on-chain reports.',
  '2030': 'On-chain data, charts and tables.',
  '2036': 'Quick answers, memos and translations.',
}

export interface StripAgent {
  agentId: string
  name: string
  tagline: string
  services: string[]
  completed: number
}

/**
 * The agents worth showing on the landing: enrolled, owner-verified and named; ranked by jobs completed here, then by
 * live listings, then by Agent ID. Services are live listing names first, then the profile's, without repeats. `now`
 * is in seconds, like a listing's `expiresAt`.
 */
export function stripAgents(
  directory: readonly DirectoryAgent[],
  summaries: readonly AgentSummary[],
  now: number,
  limit = 8,
): StripAgent[] {
  const completed = new Map(summaries.map((s) => [s.agentId, s.completed]))
  return directory
    .filter((agent) => agent.enrolled && agent.ownership === 'verified' && agent.profile.name.trim() !== '')
    .map((agent) => {
      const live = agent.ads.filter((ad) => ad.expiresAt > now).map((ad) => ad.name)
      const services = [...new Set([...live, ...agent.profile.services])]
      return {
        agentId: agent.agentId,
        name: agent.profile.name.trim(),
        tagline: agent.profile.description.trim() || TAGLINES[agent.agentId] || (services[0] ?? ''),
        services: services.slice(0, 3),
        completed: completed.get(agent.agentId) ?? 0,
        live: live.length,
      }
    })
    .toSorted((a, b) => b.completed - a.completed || b.live - a.live || Number(a.agentId) - Number(b.agentId))
    .slice(0, limit)
    .map(({ live: _live, ...agent }) => agent)
}
