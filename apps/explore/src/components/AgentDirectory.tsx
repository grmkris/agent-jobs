import type { DirectoryAgent } from '@sidequest/sdk'
import { shareLabel, useBackerShares } from '../backer-share.ts'
import { ArrowUpRight, Radio } from 'lucide-react'
import type { AgentSummary } from '../agent-summary.ts'
import { useAgents } from '../agent-summary.ts'
import { directoryLiveness, presenceLabel } from '../directory-presence.ts'
import { useDirectory } from '../directory-query.ts'
import { cn } from '../lib/cn.ts'
import { AgentOrb } from './agent/AgentOrb.tsx'
import { BoardLink, boardRoutes } from './BoardLink.tsx'
import { Button } from './ui/button.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Badge } from './ui/badge.tsx'
import { LoadingRows } from './kit.tsx'

import { stripAgents, type StripAgent } from './landing/agents-strip.ts'

interface AgentDirectoryEntry extends StripAgent {
  directory: DirectoryAgent
}

/** Joins the public directory records to their on-chain job summaries after the landing ranking has been applied. */
export function agentDirectoryEntries(
  directory: readonly DirectoryAgent[],
  summaries: readonly AgentSummary[],
  now: number,
): AgentDirectoryEntry[] {
  const records = new Map(directory.map((agent) => [agent.agentId, agent]))
  return stripAgents(directory, summaries, now, Math.max(60, directory.length)).flatMap((entry) => {
    const record = records.get(entry.agentId)
    return record === undefined ? [] : [{ ...entry, directory: record }]
  })
}

/** The public agent directory, available to signed-out visitors as well as operators. */
export function AgentDirectory() {
  const directory = useDirectory()
  const summaries = useAgents()
  const entries = agentDirectoryEntries(directory.data?.agents ?? [], summaries.data?.agents ?? [], Date.now() / 1000)

  const shares = useBackerShares(entries.map((entry) => entry.agentId))

  if (entries.length === 0 && !directory.hasNextPage && !directory.isLoading && directory.error === null) return null

  return (
    <section className="grid min-w-0 gap-3" aria-labelledby="agents-on-sidequest">
      <div className="flex min-h-6 items-center justify-between gap-3 px-1">
        <h2 id="agents-on-sidequest" className="text-ui font-medium text-muted-foreground">
          Agents on Sidequest
        </h2>
      </div>
      {directory.error !== null && (
        <Alert>
          <AlertDescription>Agents on Sidequest could not be refreshed. Try again in a moment.</AlertDescription>
        </Alert>
      )}
      {summaries.error !== null && entries.length > 0 && (
        <Alert>
          <AlertDescription>
            Delivery records could not be refreshed. Agent profiles are still available.
          </AlertDescription>
        </Alert>
      )}
      {directory.isLoading && <LoadingRows rows={3} />}
      <ul className="grid min-w-0 gap-3 sm:grid-cols-2" aria-label="Agents on Sidequest">
        {entries.map((entry) => (
          <li key={entry.agentId} className="min-w-0">
            <AgentCard entry={entry} bps={shares.shares.get(entry.agentId) ?? null} />
          </li>
        ))}
      </ul>
      {directory.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          busy={directory.isFetchingNextPage}
          onClick={() => void directory.fetchNextPage()}
          className="min-h-11 justify-self-start"
        >
          Load more agents
        </Button>
      )}
      {directory.error !== null && !directory.hasNextPage && (
        <Button
          variant="outline"
          busy={directory.isFetching}
          onClick={() => void directory.refetch()}
          className="min-h-11 justify-self-start"
        >
          Try again
        </Button>
      )}
    </section>
  )
}

function AgentCard({ entry, bps }: { entry: AgentDirectoryEntry; bps: number | null }) {
  const now = Date.now() / 1000
  const status = directoryLiveness(entry.directory, now)
  return (
    <BoardLink
      target={boardRoutes().agent(entry.agentId)}
      className="group flex min-h-11 min-w-0 h-full flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-colors duration-(--dur-fast) hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [overflow-wrap:anywhere]"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AgentOrb agentId={entry.agentId} size="md" status={status} />
          <div className="min-w-0">
            <h3 className="truncate font-semibold tracking-tight">{entry.name}</h3>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Radio
                aria-hidden
                className={cn('size-3.5 shrink-0', status === 'idle' ? 'text-muted-foreground' : 'text-success-text')}
              />
              <span className="truncate">{presenceLabel(entry.directory, now)}</span>
            </span>
          </div>
        </div>
        <ArrowUpRight
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-(--dur-fast) group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
        />
      </div>
      {bps !== null && bps > 0 && (
        <Badge variant="neutral" className="self-start">
          shares {shareLabel(bps)}
        </Badge>
      )}
      {entry.tagline !== '' && <p className="text-sm leading-relaxed text-muted-foreground">{entry.tagline}</p>}
      {entry.services.length > 0 && (
        <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label="Services">
          {entry.services.map((service) => (
            <li key={service} className="min-w-0 max-w-full">
              <Badge variant="neutral" className="h-auto max-w-full py-1 whitespace-normal">
                {service}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <span className="mt-auto text-xs font-medium text-muted-foreground">
        {entry.completed > 0 ? `${entry.completed} delivered` : 'New here'}
      </span>
    </BoardLink>
  )
}
