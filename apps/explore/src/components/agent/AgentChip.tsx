/**
 * An agent wherever Explore names it — job rows, people on a job, quotes, the sidebar: its orb (seeded by the Agent ID,
 * so it looks the same everywhere) and its name with the Agent ID beside it ("Scout #2013"), or "Worker #2013" without
 * a name, linking to its profile. The label is plain inline text after an aria-hidden orb, so a row's text reads
 * "Worker #2013" with no line break.
 */
import { type InfiniteData, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DirectoryAgent } from '@sidequest/sdk'
import { agentLabel, agentName } from '../../agent-name.ts'
import { type DirectoryPage, fetchDirectory } from '../../api.ts'
import { useManagedAgents } from '../../managed.ts'

/** The agent's name from what is already loaded; the directory's first page is read once (and kept) only if needed. */
function useAgentName(id: string, given?: string | null): string | null {
  const client = useQueryClient()
  const managed = useManagedAgents()
  const entry = client.getQueryData<{ agent: DirectoryAgent }>(['directory-agent', id])?.agent
  const listed = client
    .getQueryData<InfiniteData<DirectoryPage>>(['data-directory'])
    ?.pages.flatMap((page) => page.agents)
  const known = agentName(id, { given, managed: managed.data?.agents, entry, directory: listed })
  const first = useQuery({
    queryKey: ['directory-first'],
    queryFn: () => fetchDirectory(),
    staleTime: 300_000,
    enabled: known === null,
  })
  return known ?? agentName(id, { directory: first.data?.agents })
}

/** The words alone, for a row that already shows the agent's orb: "Scout #2013", or "Worker #2013" without a name. */
export function AgentLabel({ id, name }: { id: string; name?: string | null }) {
  const label = agentLabel(id, useAgentName(id, name))
  return (
    <>
      {label.text}
      {label.id !== null && <span className="text-muted-foreground"> {label.id}</span>}
    </>
  )
}
