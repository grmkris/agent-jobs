import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../components/ui/empty.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { ItemGroup, Item, ItemTitle, ItemContent, ItemActions } from '../components/ui/item.tsx'
import { LoadingRows, Segmented, textLinkClass } from '../components/kit.tsx'
import type { Phase } from '@sidequest/react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { BriefcaseBusiness, ChevronRight, Search, Tag as TagIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type ChainJob, type TaskIndexEntry, chainJobs, currentBoardId, taskIndex } from '../api.ts'
import { BoardLink, boardRoutes } from '../components/BoardLink.tsx'
import { PhaseBadge, phaseOf } from '../components/Phase.tsx'
import { JobsHeader } from '../components/JobsHeader.tsx'
import { NeedsYou } from '../components/NeedsYou.tsx'
import { useNow } from '../components/Time.tsx'

import { Monogram, useAuth } from '../components/Wallet.tsx'
import { amount, relative } from '../format.ts'
import { useToken } from '../useTokens.ts'

export interface JobListItem {
  jobId: string | null
  task: TaskIndexEntry | undefined
  chain: ChainJob | undefined
}

/** Stable, so useQueries keeps the combined array until one of the lists changes. */
const dataOf = (results: { data?: TaskIndexEntry[] | undefined; error: Error | null; refetch: () => Promise<unknown> }[]) =>
  results.map((result) => ({ data: result.data, error: result.error, refetch: result.refetch }))

export function useJobs() {
  const tasks = useQuery({
    queryKey: ['task_index', currentBoardId()],
    queryFn: () => taskIndex(),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
  const boardId = currentBoardId()
  const chain = useQuery({
    queryKey: ['chain-jobs', boardId],
    queryFn: () => chainJobs(boardId),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
  // The public list also shows jobs published on other boards; their titles and board state come from those boards.
  const others = useMemo(
    () =>
      [...new Set((chain.data?.jobs ?? []).flatMap((c) => (c.board_id != null && c.board_id !== boardId ? [c.board_id] : [])))].toSorted(),
    [chain.data, boardId],
  )
  const otherData = useQueries({
    queries: others.map((id) => ({ queryKey: ['task_index', id], queryFn: () => taskIndex(id), refetchInterval: 60_000 })),
    combine: dataOf,
  })
  const items = useMemo(() => {
    const byJob = new Map<string, JobListItem>()
    for (const c of chain.data?.jobs ?? []) byJob.set(c.job_id, { jobId: c.job_id, chain: c, task: undefined })
    const out: JobListItem[] = []
    for (const t of tasks.data ?? []) {
      if (t.jobId !== null && byJob.has(t.jobId)) (byJob.get(t.jobId) as JobListItem).task = t
      // Awaiting publish, or published but not indexed yet (the indexer reads finalized blocks once a minute).
      else out.push({ jobId: t.jobId, task: t, chain: undefined })
    }
    others.forEach((id, i) => {
      for (const t of otherData[i]?.data ?? []) {
        const row = t.jobId === null ? undefined : byJob.get(t.jobId)
        if (row !== undefined && row.chain?.board_id === id) row.task = t
      }
    })
    return [...byJob.values(), ...out].toSorted((a, b) => Number(b.jobId ?? 1e9) - Number(a.jobId ?? 1e9))
  }, [tasks.data, chain.data, others, otherData])
  return {
    items,
    index: chain.data?.index ?? null,
    loading: tasks.isLoading || chain.isLoading,
    error: tasks.error ?? chain.error,
    chainError: chain.error,
    boardError: tasks.error ?? otherData.find((result) => result.error !== null)?.error ?? null,
    chainReady: chain.data !== undefined,
    chainUpdatedAt: chain.dataUpdatedAt,
    chainUnavailable: chain.error !== null && chain.data === undefined,
    refetch: async () => {
      await Promise.all([tasks.refetch(), chain.refetch(), ...otherData.map((result) => result.refetch())])
    },
  }
}

type View = 'all' | 'open' | 'progress' | 'done' | 'mine'

/** Which list a phase belongs in: open to agents, under way, or finished. */
function viewOf(phase: Phase | null): Exclude<View, 'all' | 'mine'> | null {
  if (phase === null) return null
  if (phase.terminal) return 'done'
  if (['draft', 'draft-stale', 'hire-open'].includes(phase.key)) return 'open'
  return 'progress'
}

/** The row's second line: the deadline or the step waiting, in a few words. */
function rowNote(phase: Phase | null, now: number, agentId: string | null | undefined): string {
  if (phase === null) return ''
  const d = phase.deadline
  switch (phase.key) {
    case 'active':
      return d !== null ? `Due ${relative(d, now)}` : 'Under way'
    case 'hire-open':
      return d !== null ? `Taking applications · due ${relative(d, now)}` : 'Taking applications'
    case 'in-review':
      return d !== null ? `Pays itself ${relative(d, now)} if no answer` : 'Waiting for the approver'
    case 'rejected-pending':
      return d !== null ? `Dispute window closes ${relative(d, now)}` : 'The agent may dispute'
    case 'disputed':
      return d !== null ? `Ruling due ${relative(d, now)}` : 'With the arbitrator'
    case 'overdue':
    case 'rejection-final':
    case 'arbitration-lapsed':
      return 'Anyone can close it'
    case 'accepted-by-silence':
      return 'Anyone can release the payment'
    case 'hire-lapsed':
      return 'The creator can cancel for a refund'
    case 'completed':
      return agentId != null ? `Agent #${agentId} paid` : 'Paid'
    case 'draft':
      return 'Only you can see this'
    default:
      return ''
  }
}

function readView(): { view: View; q: string } {
  const p = new URLSearchParams(window.location.search)
  const v = p.get('view')
  return { view: v === 'open' || v === 'progress' || v === 'done' || v === 'mine' ? v : 'all', q: p.get('q') ?? '' }
}

export function JobsPage() {
  const { items, index, loading, error, chainError, boardError, chainReady, chainUpdatedAt, chainUnavailable, refetch } = useJobs()
  const { address } = useAuth()
  const routes = boardRoutes()
  const now = useNow()
  const minute = Math.floor(now / 60) * 60
  const [{ view, q }, setFilter] = useState(readView)
  // Filters live in the URL, so a link or a reload keeps them.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    if (view === 'all') p.delete('view')
    else p.set('view', view)
    if (q === '') p.delete('q')
    else p.set('q', q)
    const s = p.toString()
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${s === '' ? '' : `?${s}`}`)
  }, [view, q])

  const me = address?.toLowerCase()
  const rows = useMemo(
    () =>
      items
        // An offer never published is a draft: nothing is escrowed, so only its creator sees it.
        .filter((i) => i.jobId !== null || (me !== undefined && i.task?.creator.toLowerCase() === me))
        .map((i) => ({ item: i, phase: phaseOf(i.chain, i.task, address, minute) })),
    [items, me, address, minute],
  )
  const mine = (i: JobListItem) =>
    me !== undefined &&
    [i.chain?.creator, i.chain?.approver, i.chain?.worker, i.task?.creator, i.task?.approver].some((a) => a?.toLowerCase() === me)
  const counts = { all: rows.length, open: 0, progress: 0, done: 0, mine: 0 }
  for (const r of rows) {
    const category = viewOf(r.phase)
    if (category !== null) counts[category]++
    if (mine(r.item)) counts.mine++
  }
  const needle = q.trim().toLowerCase()
  const shown = rows.filter(
    (r) =>
      (view === 'all' || (r.phase !== null && (view === 'mine' ? mine(r.item) : viewOf(r.phase) === view))) &&
      (needle === '' || (r.item.task?.title ?? '').toLowerCase().includes(needle) || r.item.jobId === needle.replace(/^#/, '')),
  )
  const views: Array<readonly [View, string]> = [
    ['all', 'All'],
    ['open', 'Open'],
    ['progress', 'Under way'],
    ['done', 'Done'],
    ...(address !== undefined ? [['mine', 'Mine'] as const] : []),
  ]

  return (
    <>
      <JobsHeader current="jobs" />

      <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:items-center">
        <label className="flex min-h-8 items-center gap-2 rounded-lg border border-input px-2.5 text-muted-foreground transition-colors duration-(--dur-fast) focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 pointer-coarse:min-h-11">
          <Search aria-hidden className="size-4 shrink-0" />
          <input
            value={q}
            onChange={(e) => setFilter({ view, q: e.target.value })}
            placeholder="Search jobs"
            aria-label="Search jobs"
            className="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none md:text-sm"
          />
        </label>
        <Segmented
          label="Which jobs"
          value={view}
          onChange={(v) => setFilter({ view: v, q })}
          options={views.map(
            ([v, l]) =>
              [
                v,
                <span key={v}>
                  {l} <span className="tabular-nums text-muted-foreground">{chainReady ? counts[v] : '—'}</span>
                </span>,
              ] as const,
          )}
        />
      </div>

      {(chainError !== null || boardError !== null) && (
        <div role="status" className="grid gap-2 rounded-xl bg-warning/14 p-4 text-sm text-warning-text">
          {chainError !== null && (
            <p>
              Chain data is unavailable.
              {chainReady
                ? ` Showing last-known chain facts from ${new Date(chainUpdatedAt).toLocaleString()}; statuses have not been changed.`
                : ' Payment statuses and counts cannot be confirmed.'}
            </p>
          )}
          {boardError !== null && (
            <p>
              Board details are unavailable. Existing chain facts still determine payment status; some titles or board details may be
              missing.
            </p>
          )}
          <Button variant="secondary" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      )}

      {chainUnavailable ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{'Chain jobs are unavailable'}</EmptyTitle>
            <EmptyDescription>
              The board list is available, but chain status and counts are not. Retry when the chain index is reachable.
              <Button size="default" variant="secondary" onClick={() => void refetch()}>
                Retry chain data
              </Button>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : error !== null && items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{'Jobs are unavailable'}</EmptyTitle>
            <EmptyDescription>
              <Alert variant="destructive">
                <AlertDescription>{(error as Error).message}</AlertDescription>
              </Alert>
              <Button size="default" variant="secondary" onClick={() => void refetch()}>
                Retry
              </Button>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : loading ? (
        <LoadingRows rows={6} />
      ) : shown.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{needle !== '' ? 'No jobs match' : view === 'mine' ? 'Nothing of yours yet' : 'No jobs here yet'}</EmptyTitle>
            <EmptyDescription>
              {view === 'mine' || rows.length === 0 ? (
                <BoardLink target={routes.publish()} className={textLinkClass}>
                  Post the first one
                </BoardLink>
              ) : null}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {view === 'mine' && <NeedsYou rows={shown} />}

          <ItemGroup>
            {shown.map(({ item, phase }) => (
              <JobRow
                key={item.jobId ?? item.task?.taskId}
                item={item}
                phase={phase}
                note={phase === null ? 'Status unavailable · retry chain data' : rowNote(phase, now, item.chain?.agent_id)}
              />
            ))}
          </ItemGroup>
        </>
      )}

      <p className="px-4 text-xs text-muted-foreground">
        {!chainReady
          ? 'Chain facts are unavailable.'
          : index === null
            ? 'The chain index is not built yet.'
            : `Chain facts up to block ${(index.next_block - 1).toLocaleString('en-US')}, refreshed every minute.`}{' '}
        Jobs from before titles were kept show as “Job #N”.
      </p>
    </>
  )
}

export function JobRow({ item, phase, note }: { item: JobListItem; phase: Phase | null; note: string }) {
  const routes = boardRoutes()
  const agentId = item.chain?.agent_id
  const reward = item.chain?.reward ?? item.task?.reward
  const token = item.chain?.token ?? item.task?.token
  const meta = useToken(token)
  const rewardText = meta === 'reading' ? 'Reading token…' : meta === 'none' ? 'Token unavailable' : amount(reward, token)
  const other = routes.boardId === 'public' && item.chain?.board_id != null && item.chain.board_id !== 'public' ? item.chain.board_id : null
  const target =
    item.jobId === null
      ? { ...routes.publish(), search: { resume: item.task?.taskId } }
      : other !== null
        ? { to: '/b/$boardId/job/$jobId', params: { boardId: other, jobId: item.jobId } }
        : routes.job(item.jobId)
  const Icon = item.task?.quoted === true ? TagIcon : BriefcaseBusiness
  return (
    <Item
      render={
        <Link
          to={target.to as '/'}
          params={(target.params ?? {}) as never}
          search={('search' in target ? target.search : undefined) as never}
        />
      }
    >
      {agentId != null && agentId !== '0' ? (
        <Monogram seed={`agent-${agentId}`} label={agentId.slice(-2)} size="md" />
      ) : (
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-muted-foreground">
          <Icon aria-hidden className="size-[1.1rem]" />
        </span>
      )}
      <ItemContent className="min-w-0 flex-1">
        <ItemTitle className="block truncate font-medium">{item.task?.title ?? `Job #${item.jobId}`}</ItemTitle>
        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-ui text-muted-foreground">
          <PhaseBadge phase={phase} />
          {other !== null && <Badge variant="info">{other}</Badge>}
          <span className="truncate">{note}</span>
        </span>
      </ItemContent>
      <ItemActions className="min-w-0 max-w-[38%] shrink flex-col items-end text-right">
        <span className="tabular-nums block whitespace-normal font-semibold [overflow-wrap:anywhere]">{rewardText}</span>
        <span className="block text-xs text-muted-foreground">{item.jobId !== null ? `#${item.jobId}` : 'Draft'}</span>
      </ItemActions>
      <ItemActions>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </ItemActions>
    </Item>
  )
}
