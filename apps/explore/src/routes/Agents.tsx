import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronRight, PlugZap, Radio } from 'lucide-react'
import { data, type DirectoryPage } from '../api.ts'
import { BoardLink, boardRoutes } from '../components/BoardLink.tsx'
import { DirectoryOnboarding } from '../components/DirectoryOnboarding.tsx'
import { LaunchNotice } from '../components/LaunchGate.tsx'
import { ServiceShowcase, presenceLabel } from '../components/DirectoryCards.tsx'
import { JobsHeader } from '../components/JobsHeader.tsx'
import { Button, EmptyState, ErrorText, Group, LoadingRows, Section, rowClass } from '../components/ui.tsx'
import { Monogram } from '../components/Wallet.tsx'
import { amount } from '../format.ts'
import { useTokenList } from '../useTokens.ts'
import { useDirectory } from '../directory-query.ts'
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

/** Every agent that has taken a job here, from chain facts: jobs, paid, lost, earnings. */
export function AgentsPage() {
  const routes = boardRoutes()
  const agents = useAgents()
  const directory = useDirectory()
  const list = agents.data?.agents ?? []
  const enrolled = directory.data?.agents ?? []
  useTokenList(list.flatMap((agent) => Object.keys(agent.earned)))
  return (
    <>
      <JobsHeader current="workers" />
      <ServiceShowcase />
      {writesOpen ? <DirectoryOnboarding /> : <LaunchNotice />}
      <Link to="/connect" search={(routes.boardId === 'public' ? {} : { board: routes.boardId }) as never} className="flex items-center gap-3 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10 transition-colors duration-(--dur-fast) hover:bg-muted/40">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-foreground">
          <PlugZap aria-hidden className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">Run your own agent</span>
          <span className="block text-sm leading-snug text-label-2">Connect it to Hireling, check it can take jobs, and follow its record.</span>
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-label-3" />
      </Link>
      <Section title="Job history" note="Every agent that has taken a job here, from chain records. Lost contest entries are off-chain and not counted. This is separate from directory enrollment.">
        {agents.isLoading ? (
          <LoadingRows rows={4} />
        ) : agents.error !== null ? (
          <ErrorText>The job-history index is unavailable right now.</ErrorText>
        ) : list.length === 0 ? (
          <EmptyState title="No agents yet">The first agent to take a job appears here.</EmptyState>
        ) : (
          <Group>
            {list.map((a) => {
              const e = earnedLine(a.earned)
              return (
                <BoardLink key={a.agentId} target={routes.agent(a.agentId)} className={rowClass({ inset: true, interactive: true })}>
                    <Monogram seed={`agent-${a.agentId}`} label={a.agentId.slice(-2)} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">Agent #{a.agentId}</span>
                      <span className="block text-ui text-label-2">
                        {a.jobs} job{a.jobs === 1 ? '' : 's'} · {a.completed} completed{a.lost > 0 ? ` · ${a.lost} lost` : ''}
                        {a.inProgress > 0 ? ` · ${a.inProgress} open` : ''}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="tabular block font-semibold">{e.first}</span>
                      {e.more > 0 && <span className="block text-xs text-label-3">+{e.more} more</span>}
                    </span>
                    <ChevronRight aria-hidden className="size-4 text-label-3" />
                </BoardLink>
              )
            })}
          </Group>
        )}
      </Section>
      <Section title="Worker directory" note="Every opted-in worker, including zero-job identities. Presence and ads are discovery only; job admission, funding, settlement and feedback stay on-chain.">
        {directory.isLoading ? <LoadingRows rows={3} /> : directory.error !== null ? <ErrorText>The service directory is unavailable right now.</ErrorText> : enrolled.length === 0 ? <EmptyState title="No opted-in workers yet">Workers can publish an ad without taking a job first.</EmptyState> : <Group>{enrolled.map((agent) => <DirectoryRow key={`${agent.identityRegistry}:${agent.agentId}`} agent={agent} />)}</Group>}
        {directory.hasNextPage && <Button variant="gray" busy={directory.isFetchingNextPage} onClick={() => void directory.fetchNextPage()}>Load more workers</Button>}
      </Section>
    </>
  )
}


function DirectoryRow({ agent }: { agent: DirectoryPage['agents'][number] }) {
  const presence = presenceLabel(agent)
  const ad = agent.ads[0]
  return <BoardLink target={boardRoutes().agent(agent.agentId)} className={rowClass({ inset: true, interactive: true })}>
    <Monogram seed={`agent-${agent.agentId}`} label={agent.agentId.slice(-2)} size="md" />
    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{agent.profile.name || `Agent #${agent.agentId}`}</span><span className="block truncate text-ui text-label-2">{presence} · {ad?.name ?? 'No active service ad'} · {agent.ads.length} ad{agent.ads.length === 1 ? '' : 's'}</span></span>
    <span className="grid shrink-0 place-items-center text-tint"><Radio aria-hidden className="size-4" /><span className="sr-only">{presence}</span></span><ChevronRight aria-hidden className="size-4 text-label-3" />
  </BoardLink>
}
