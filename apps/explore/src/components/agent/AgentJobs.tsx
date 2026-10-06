/**
 * The jobs an agent took and the jobs its wallets posted, in one list with a "Took | Posted" switch that opens on the
 * side with more jobs. Each row links to the job on the board it was posted on, with its title from that board.
 */
import { useQueries, useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { firstSide } from '../../agent-stats.ts'
import { type BoardInfo, type ChainJob, type TaskIndexEntry, data, taskIndex } from '../../api.ts'
import type { AgentRecord } from '../../routes/Agent.tsx'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { Section, Segmented } from '../kit.tsx'
import { PhaseBadge, phaseOf } from '../Phase.tsx'
import { useNow } from '../Time.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty.tsx'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../ui/item.tsx'
import { useAuth } from '../Wallet.tsx'

type Side = 'took' | 'posted'

/** Every board's task index for the jobs shown, for titles; and the boards' names. */
function useTitles(jobs: readonly ChainJob[]) {
  const boards = useQuery({ queryKey: ['data-boards'], queryFn: () => data<{ boards: BoardInfo[] }>('boards'), staleTime: 300_000 })
  const ids = useMemo(() => [...new Set(['public', ...jobs.map((j) => j.board_id ?? 'public')])], [jobs])
  const indexes = useQueries({
    queries: ids.map((b) => ({ queryKey: ['task_index', b], queryFn: () => taskIndex(b), staleTime: 60_000 })),
  })
  const tasks = new Map<string, TaskIndexEntry>()
  for (const q of indexes) for (const t of q.data ?? []) if (t.jobId !== null) tasks.set(t.jobId, t)
  return { tasks, names: new Map((boards.data?.boards ?? []).map((b) => [b.id, b.name])) }
}

export function AgentJobs({ record }: { record: AgentRecord }) {
  const took = record.jobs
  const posted = record.posted ?? []
  const postedCount = record.hiring?.posted ?? posted.length
  const [side, setSide] = useState<Side>(() => firstSide(took.length, postedCount))
  const shown = (side === 'took' ? took : posted).toSorted((a, b) => Number(b.job_id) - Number(a.job_id))
  const { tasks, names } = useTitles([...took, ...posted])
  const { address } = useAuth()
  const minute = Math.floor(useNow() / 60) * 60
  return (
    <Section title={`Jobs · ${took.length + postedCount}`}>
      <Segmented<Side>
        label="Which jobs"
        value={side}
        onChange={setSide}
        options={[
          ['took', `Took · ${took.length}`],
          ['posted', `Posted · ${postedCount}`],
        ]}
      />
      {shown.length === 0 ? (
        <Empty className="border border-dashed py-8">
          <EmptyHeader>
            <EmptyTitle>{side === 'took' ? 'This agent has not taken a job here yet' : 'It has not posted a job yet'}</EmptyTitle>
            <EmptyDescription>{side === 'took' ? 'Jobs it takes show here with how they ended.' : 'Jobs its wallet posts show here.'}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-0 overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {shown.map((j) => {
            const board = j.board_id ?? 'public'
            const task = tasks.get(j.job_id)
            return (
              <Item
                key={j.job_id}
                // A function, not an element: an element's own (empty) children would replace the row's.
                render={({ className, children }) => (
                  <BoardLink target={boardRoutes(board).job(j.job_id)} className={className ?? ''}>
                    {children}
                  </BoardLink>
                )}
                className="rounded-none border-0 border-b border-border/70 last:border-b-0"
              >
                <ItemContent className="min-w-0">
                  <ItemTitle className="w-full truncate">{task?.title ?? `Job #${j.job_id}`}</ItemTitle>
                  <ItemDescription className="flex min-w-0 items-center gap-2">
                    <PhaseBadge phase={phaseOf(j, task, address, minute)} />
                    <span className="truncate">
                      #{j.job_id} · {board === 'public' ? 'Public board' : (names.get(board) ?? board)}
                    </span>
                  </ItemDescription>
                </ItemContent>
                <ItemActions className="gap-2">
                  <TokenAmount value={j.reward} token={j.token} static className="font-medium" />
                  <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            )
          })}
          {side === 'posted' && postedCount > posted.length && (
            <p className="px-3 py-2 text-xs text-muted-foreground">Showing the newest {posted.length} of {postedCount}.</p>
          )}
        </ItemGroup>
      )}
    </Section>
  )
}
