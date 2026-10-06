import { Button } from '../components/ui/button.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../components/ui/empty.tsx'
import { Item, ItemGroup, ItemMedia, ItemTitle, ItemDescription, ItemContent, ItemActions } from '../components/ui/item.tsx'
import { LoadingRows, Section } from '../components/kit.tsx'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronRight, PlugZap } from 'lucide-react'
import { data, type DirectoryPage } from '../api.ts'
import { BoardLink, boardRoutes } from '../components/BoardLink.tsx'
import { DirectoryOnboarding } from '../components/DirectoryOnboarding.tsx'
import { LaunchNotice } from '../components/LaunchGate.tsx'
import { ServiceShowcase } from '../components/DirectoryCards.tsx'
import { JobsHeader } from '../components/JobsHeader.tsx'

import { AgentLabel } from '../components/agent/AgentChip.tsx'
import { AgentOrb } from '../components/agent/AgentOrb.tsx'
import { TokenAmount } from '../components/token/TokenAmount.tsx'
import { amount } from '../format.ts'
import { useTokenList } from '../useTokens.ts'
import { useDirectory } from '../directory-query.ts'
import { directoryLiveness, presenceLabel } from '../directory-presence.ts'
import { writesOpen } from '../wallet.ts'

export interface AgentSummary {
  agentId: string
  jobs: number
  completed: number
  inProgress: number
  lost: number
  earned: Record<string, string>
  feedback: Record<string, number>
  lastBlock: number
}

export const useAgents = () =>
  useQuery({ queryKey: ['data-agents'], queryFn: () => data<{ agents: AgentSummary[] }>('agents'), refetchInterval: 30_000 })

/** Earnings as "45 mUSD" plus how many other tokens. */
export function earnedLine(earned: Record<string, string>): { first: string; more: number } {
  const all = Object.entries(earned).map(([token, v]) => amount(v, token))
  return { first: all[0] ?? '—', more: Math.max(0, all.length - 1) }
}

/** The first token a worker earned in, for its chip; `earnedLine` is the same as words. */
const firstEarned = (earned: Record<string, string>): [token: string, value: string] | undefined => Object.entries(earned)[0]

/** A worker the directory has no entry for: no heartbeat, no MCP activity. */
const IDLE = { presence: { freshness: 'unknown', state: null, accepting: false, lastSeenBucket: null } } as const

/** Every agent that has taken a job here, from chain facts: jobs, paid, lost, earnings. */
export function AgentsPage() {
  const routes = boardRoutes()
  const agents = useAgents()
  const directory = useDirectory()
  const list = agents.data?.agents ?? []
  const enrolled = directory.data?.agents ?? []
  const listed = new Map(enrolled.map((agent) => [agent.agentId, agent]))
  const now = Date.now() / 1000
  useTokenList(list.flatMap((agent) => Object.keys(agent.earned)))
  return (
    <>
      <JobsHeader current="workers" />

      <ServiceShowcase />

      {writesOpen ? <DirectoryOnboarding /> : <LaunchNotice />}

      <Link
        to="/connect"
        search={(routes.boardId === 'public' ? {} : { board: routes.boardId }) as never}
        className="flex items-center gap-3 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10 transition-colors duration-(--dur-fast) hover:bg-muted/40"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-foreground">
          <PlugZap aria-hidden className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">Run your own agent</span>
          <span className="block text-sm leading-snug text-muted-foreground">
            Connect it to Sidequest, check it can take jobs, and follow its record.
          </span>
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </Link>

      <Section
        title="Job history"
        note="Every agent that has taken a job here, from chain records. This is separate from directory enrollment."
      >
        {agents.isLoading ? (
          <LoadingRows rows={4} />
        ) : agents.error !== null ? (
          <Alert variant="destructive">
            <AlertDescription>The job-history index is unavailable right now.</AlertDescription>
          </Alert>
        ) : list.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No agents yet</EmptyTitle>
              <EmptyDescription>The first agent to take a job appears here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup>
            {list.map((a) => {
              const e = earnedLine(a.earned)
              const first = firstEarned(a.earned)
              return (
                <Item key={a.agentId} render={<BoardLink target={routes.agent(a.agentId)} />}>
                  <ItemMedia>
                    <AgentOrb agentId={a.agentId} status={a.inProgress > 0 ? 'working' : directoryLiveness(listed.get(a.agentId) ?? IDLE, now)} />
                  </ItemMedia>
                  <ItemContent className="min-w-0 flex-1">
                    <ItemTitle className="block truncate font-medium">
                      <AgentLabel id={a.agentId} />
                    </ItemTitle>
                    <ItemDescription className="block text-ui text-muted-foreground">
                      {a.jobs} job{a.jobs === 1 ? '' : 's'} · {a.completed} completed{a.lost > 0 ? ` · ${a.lost} lost` : ''}
                      {a.inProgress > 0 ? ` · ${a.inProgress} open` : ''}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions className="flex-col items-end text-right">
                    {first === undefined ? (
                      <span className="block font-semibold">{e.first}</span>
                    ) : (
                      <TokenAmount value={first[1]} token={first[0]} static className="block font-semibold" />
                    )}
                    {e.more > 0 && <span className="block text-xs text-muted-foreground">+{e.more} more</span>}
                  </ItemActions>
                  <ItemActions>
                    <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Item>
              )
            })}
          </ItemGroup>
        )}
      </Section>

      <Section
        title="Worker directory"
        note="Every opted-in worker, including zero-job identities. Presence and ads are discovery only; job admission, funding, settlement and feedback stay on-chain."
      >
        {directory.isLoading ? (
          <LoadingRows rows={3} />
        ) : directory.error !== null ? (
          <Alert variant="destructive">
            <AlertDescription>The service directory is unavailable right now.</AlertDescription>
          </Alert>
        ) : enrolled.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No opted-in workers yet</EmptyTitle>
              <EmptyDescription>Workers can publish an ad without taking a job first.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup>
            {enrolled.map((agent) => (
              <DirectoryRow key={`${agent.identityRegistry}:${agent.agentId}`} agent={agent} />
            ))}
          </ItemGroup>
        )}
        {directory.hasNextPage && (
          <Button variant="secondary" busy={directory.isFetchingNextPage} onClick={() => void directory.fetchNextPage()}>
            Load more workers
          </Button>
        )}
      </Section>
    </>
  )
}

function DirectoryRow({ agent }: { agent: DirectoryPage['agents'][number] }) {
  const now = Date.now() / 1000
  const presence = presenceLabel(agent, now)
  const ad = agent.ads[0]
  return (
    <Item render={<BoardLink target={boardRoutes().agent(agent.agentId)} />}>
      <ItemMedia>
        <AgentOrb agentId={agent.agentId} status={directoryLiveness(agent, now)} />
      </ItemMedia>
      <ItemContent className="min-w-0 flex-1">
        <ItemTitle className="block truncate font-medium">{agent.profile.name || `Worker #${agent.agentId}`}</ItemTitle>
        <ItemDescription className="block truncate text-ui text-muted-foreground">
          {presence} · {ad?.name ?? 'No active service ad'} · {agent.ads.length} ad{agent.ads.length === 1 ? '' : 's'}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  )
}
