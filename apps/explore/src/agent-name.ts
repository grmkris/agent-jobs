/**
 * What Explore calls an agent in a row, a list or a chip: its name with its Agent ID beside it ("Scout #2013"), or
 * "Worker #2013" when no name is known. (Headers, setup and forms say "Agent ID 2013" instead.) The name comes from what is already at hand, in this order — a name the caller has, the operator's own
 * managed agents, the agent's cached directory entry, the directory's first page — never a profile read per mention.
 */
import type { DirectoryAgent } from '@sidequest/sdk'

const named = (name: string | null | undefined) => (typeof name === 'string' && name.trim() !== '' ? name.trim() : null)

export function agentName(
  id: string,
  sources: {
    given?: string | null | undefined
    managed?: ReadonlyArray<{ agent_id: string | null; name: string }> | undefined
    entry?: Pick<DirectoryAgent, 'agentId' | 'profile'> | undefined
    directory?: ReadonlyArray<Pick<DirectoryAgent, 'agentId' | 'profile'>> | undefined
  },
): string | null {
  return (
    named(sources.given) ??
    named(sources.managed?.find((a) => a.agent_id === id)?.name) ??
    named(sources.entry?.agentId === id ? sources.entry.profile.name : undefined) ??
    named(sources.directory?.find((a) => a.agentId === id)?.profile.name)
  )
}

/**
 * The words of a mention: the name (or "Worker" without one) then the muted `#id`. `nameOnly` (the sidebar) drops the
 * id from a named agent's text; the chip then carries it as a tooltip.
 */
export function agentLabel(id: string, name: string | null, nameOnly = false): { text: string; id: string | null } {
  if (name === null) return { text: 'Worker', id: `#${id}` }
  return { text: name, id: nameOnly ? null : `#${id}` }
}
