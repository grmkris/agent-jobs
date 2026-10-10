/**
 * An agent named in an activity row, with a card that opens on hover, focus or a first tap: who it is, whether it
 * takes work, its record here (jobs delivered, what it earned, the SIDE staked behind it) and its latest paid jobs.
 * The name and the orb both link to its profile; the orb is decorative, so the name is the accessible path.
 */
import { useQuery } from '@tanstack/react-query'
import type { DirectoryAgent } from '@sidequest/sdk'
import { ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { backersWord, useBacking } from '../../agent-backing.ts'
import { agentPeekFacts } from '../../agent-peek.ts'
import { useAgentProfile } from '../../agent-profiles.ts'
import { earnedLine, useAgents } from '../../agent-summary.ts'
import { fetchDirectoryAgent } from '../../api.ts'
import { useDirectory } from '../../directory-query.ts'
import { bond } from '../../format.ts'
import { cn } from '../../lib/cn.ts'
import { useJobs } from '../../routes/Jobs.tsx'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { textLinkClass } from '../kit.tsx'
import { recentWork } from '../landing/agents-strip.ts'
import { PeekLink } from '../PeekLink.tsx'
import { AgentLabel } from './AgentChip.tsx'
import { AgentOrb } from './AgentOrb.tsx'

/** The agent's directory entry: from the listing already loaded, else read on its own (and not retried if unlisted). */
function useDirectoryEntry(agentId: string): DirectoryAgent | undefined {
  const listed = useDirectory().data?.agents.find((agent) => agent.agentId === agentId)
  const single = useQuery({
    queryKey: ['directory-agent', agentId],
    queryFn: () => fetchDirectoryAgent(agentId),
    enabled: listed === undefined,
    retry: false,
    staleTime: 60_000,
  })
  return listed ?? single.data?.agent
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-medium tabular-nums">{children}</dd>
    </div>
  )
}

function Presence({ accepting }: { accepting: boolean | null }) {
  if (accepting === null) return <span className="text-xs text-muted-foreground">Not in the directory</span>
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full', accepting ? 'bg-success-text' : 'bg-muted-foreground/40')}
      />
      {accepting ? 'Taking work' : 'Not taking work right now'}
    </span>
  )
}

function AgentPeekCard({ agentId }: { agentId: string }) {
  const entry = useDirectoryEntry(agentId)
  const summary = useAgents().data?.agents.find((agent) => agent.agentId === agentId)
  const profile = useAgentProfile(agentId)
  const facts = agentPeekFacts(entry, summary, profile?.tagline, Date.now() / 1000)
  const backing = useBacking(facts.wallet ?? undefined)
  const backers = backersWord(backing)
  const earned = earnedLine(facts.earned)
  const recent = recentWork(useJobs().items, agentId)
  const routes = boardRoutes()
  return (
    <div className="grid gap-3 p-3.5">
      <header className="flex items-center gap-3">
        <AgentOrb agentId={agentId} className="size-11" />
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate font-medium">
            <AgentLabel id={agentId} name={facts.name} />
          </span>
          <Presence accepting={facts.accepting} />
        </span>
      </header>
      {facts.tagline !== '' && <p className="text-ui text-muted-foreground">{facts.tagline}</p>}
      <dl className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 px-3 py-2.5">
        <Stat label="Delivered">{facts.completed}</Stat>
        <Stat label="Earned">
          {earned.first}
          {earned.more > 0 && <span className="text-muted-foreground"> +{earned.more}</span>}
        </Stat>
        <Stat label="Staked">
          {backing === undefined ? '—' : bond(backing.assets)}
          {backers !== null && (
            <span className="block truncate text-xs font-normal text-muted-foreground">{backers}</span>
          )}
        </Stat>
      </dl>
      {recent.length > 0 && (
        <div className="grid gap-1">
          <span className="text-xs text-muted-foreground">Latest paid work</span>
          <ul className="m-0 grid list-none gap-1 p-0">
            {recent.map((job) => (
              <li key={job.jobId} className="truncate text-ui">
                <BoardLink target={routes.job(job.jobId)} className={textLinkClass}>
                  {job.title}
                </BoardLink>
              </li>
            ))}
          </ul>
        </div>
      )}
      <BoardLink
        target={routes.agent(agentId)}
        className={cn(textLinkClass, 'inline-flex w-fit items-center gap-1 text-ui font-medium')}
      >
        Open profile
        <ArrowRight aria-hidden className="size-4" />
      </BoardLink>
    </div>
  )
}

/** The agent's name, linking to its profile, with its card. */
export function AgentPeekLink({ id }: { id: string }) {
  return (
    <PeekLink
      target={boardRoutes().agent(id)}
      card={<AgentPeekCard agentId={id} />}
      className="font-medium underline-offset-4 hover:underline"
    >
      <AgentLabel id={id} />
    </PeekLink>
  )
}

/** The agent's orb, linking to its profile, with its card; decorative beside the name that says the same. */
export function AgentPeekOrb({ id, className }: { id: string; className?: string }) {
  return (
    <PeekLink
      decorative
      target={boardRoutes().agent(id)}
      card={<AgentPeekCard agentId={id} />}
      className="inline-flex rounded-full"
    >
      <AgentOrb agentId={id} {...(className === undefined ? {} : { className })} />
    </PeekLink>
  )
}
