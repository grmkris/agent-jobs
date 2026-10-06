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
import { cn } from '../../lib/cn.ts'
import { useManagedAgents } from '../../managed.ts'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { AgentOrb } from './AgentOrb.tsx'

/** The agent's name from what is already loaded; the directory's first page is read once (and kept) only if needed. */
export function useAgentName(id: string, given?: string | null): string | null {
  const client = useQueryClient()
  const managed = useManagedAgents()
  const entry = client.getQueryData<{ agent: DirectoryAgent }>(['directory-agent', id])?.agent
  const listed = client.getQueryData<InfiniteData<DirectoryPage>>(['data-directory'])?.pages.flatMap((page) => page.agents)
  const known = agentName(id, { given, managed: managed.data?.agents, entry, directory: listed })
  const first = useQuery({ queryKey: ['directory-first'], queryFn: () => fetchDirectory(), staleTime: 300_000, enabled: known === null })
  return known ?? agentName(id, { directory: first.data?.agents })
}

/** The orb and words, for a place that is already a link or button (`link={false}` on AgentChip renders this). */
export function AgentMention({ id, name, nameOnly = false }: { id: string; name: string | null; nameOnly?: boolean }) {
  const label = agentLabel(id, name, nameOnly)
  return (
    <>
      {/* Sized to the text around it, like a token's icon; AgentOrb is aria-hidden and has no in-flow text. */}
      <AgentOrb agentId={id} size="sm" className="mr-1.5 size-[1.3em] align-[-0.3em]" />
      {label.text}
      {label.id !== null && <span className="text-muted-foreground"> {label.id}</span>}
    </>
  )
}

export function AgentChip({ id, name, link = true, nameOnly = false, className }: { id: string; name?: string | null; link?: boolean; nameOnly?: boolean; className?: string }) {
  const known = useAgentName(id, name)
  const title = nameOnly && known !== null ? `Agent ID ${id}` : undefined
  const body = <AgentMention id={id} name={known} nameOnly={nameOnly} />
  if (!link)
    return (
      <span title={title} className={cn('whitespace-nowrap', className)}>
        {body}
      </span>
    )
  return (
    <BoardLink target={boardRoutes().agent(id)} className={cn('whitespace-nowrap underline-offset-4 hover:underline', className)}>
      <span title={title}>{body}</span>
    </BoardLink>
  )
}
