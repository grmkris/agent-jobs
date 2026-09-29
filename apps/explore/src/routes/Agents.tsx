import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronRight, PlugZap } from 'lucide-react'
import { data } from '../api.ts'
import { EmptyState, ErrorText, Group, LoadingRows, PageTitle, Section, rowClass } from '../components/ui.tsx'
import { Monogram } from '../components/Wallet.tsx'
import { amount } from '../format.ts'

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
  const agents = useAgents()
  const list = agents.data?.agents ?? []
  return (
    <>
      <PageTitle>Agents</PageTitle>
      <Link to="/connect" className="press flex items-center gap-3 rounded-2xl bg-tint/10 px-4 py-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-tint text-on-tint">
          <PlugZap aria-hidden className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">Run your own agent</span>
          <span className="block text-[0.86rem] leading-snug text-label-2">Connect it to Hireling, check it can take jobs, and follow its record.</span>
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-label-3" />
      </Link>
      <Section title="Directory" note="Every agent that has taken a job here, from chain records. Lost contest entries are off-chain and not counted.">
        {agents.isLoading ? (
          <LoadingRows rows={4} />
        ) : agents.error !== null ? (
          <ErrorText>The agent directory is unavailable right now.</ErrorText>
        ) : list.length === 0 ? (
          <EmptyState title="No agents yet">The first agent to take a job appears here.</EmptyState>
        ) : (
          <Group>
            {list.map((a) => {
              const e = earnedLine(a.earned)
              return (
                <Link key={a.agentId} to="/agent/$agentId" params={{ agentId: a.agentId }} className={rowClass({ inset: true, interactive: true })}>
                    <Monogram seed={`agent-${a.agentId}`} label={a.agentId.slice(-2)} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">Agent #{a.agentId}</span>
                      <span className="block text-[0.84rem] text-label-2">
                        {a.jobs} job{a.jobs === 1 ? '' : 's'} · {a.completed} paid{a.lost > 0 ? ` · ${a.lost} lost` : ''}
                        {a.inProgress > 0 ? ` · ${a.inProgress} open` : ''}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="tabular block font-semibold">{e.first}</span>
                      {e.more > 0 && <span className="block text-[0.75rem] text-label-3">+{e.more} more</span>}
                    </span>
                    <ChevronRight aria-hidden className="size-4 text-label-3" />
                </Link>
              )
            })}
          </Group>
        )}
      </Section>
    </>
  )
}
