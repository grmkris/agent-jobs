import type { Phase } from '@agent-jobs/react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, BriefcaseBusiness, ChevronRight, Search, Tag as TagIcon, Trophy } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type ChainJob, type TaskIndexEntry, boardApi, currentBoardId, data, tool } from '../api.ts'
import { BoardLink, boardRoutes } from '../components/BoardLink.tsx'
import { PhaseBadge, phaseOf } from '../components/Phase.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { useNow } from '../components/Time.tsx'
import { Badge, Button, EmptyState, ErrorText, Group, LoadingRows, PageTitle, Segmented, cn, rowClass } from '../components/ui.tsx'
import { Monogram, useAuth } from '../components/Wallet.tsx'
import { amount, relative, tokenMeta } from '../format.ts'
import { useToken, useTokenList } from '../useTokens.ts'

export interface JobListItem {
  jobId: string | null
  task: TaskIndexEntry | undefined
  chain: ChainJob | undefined
}

/** Stable, so useQueries keeps the combined array until one of the lists changes. */
const dataOf = (results: { data?: TaskIndexEntry[] | undefined }[]) => results.map((r) => r.data)

export function useJobs() {
  const tasks = useQuery({ queryKey: ['task_index', currentBoardId()], queryFn: () => tool<TaskIndexEntry[]>('task_index'), refetchInterval: 20_000 })
  const boardId = currentBoardId()
  const chain = useQuery({ queryKey: ['chain-jobs', boardId], queryFn: () => boardApi(boardId).jobs<{ jobs: ChainJob[]; index: { next_block: number; updated_at: number } | null }>(), refetchInterval: 20_000 })
  // The public list also shows jobs published on other boards; their titles and board state come from those boards.
  const others = useMemo(() => [...new Set((chain.data?.jobs ?? []).flatMap((c) => (c.board_id != null && c.board_id !== boardId ? [c.board_id] : [])))].toSorted(), [chain.data, boardId])
  const otherData = useQueries({
    queries: others.map((id) => ({ queryKey: ['task_index', id], queryFn: () => boardApi(id).tool<TaskIndexEntry[]>('task_index'), refetchInterval: 60_000 })),
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
      for (const t of otherData[i] ?? []) {
        const row = t.jobId === null ? undefined : byJob.get(t.jobId)
        if (row !== undefined && row.chain?.board_id === id) row.task = t
      }
    })
    return [...byJob.values(), ...out].toSorted((a, b) => Number(b.jobId ?? 1e9) - Number(a.jobId ?? 1e9))
  }, [tasks.data, chain.data, others, otherData])
  return { items, index: chain.data?.index ?? null, loading: tasks.isLoading || chain.isLoading, error: tasks.error ?? chain.error }
}

type View = 'all' | 'open' | 'progress' | 'done' | 'mine'

/** Which list a phase belongs in: open to agents, under way, or finished. */
function viewOf(phase: Phase | null): Exclude<View, 'all' | 'mine'> {
  if (phase === null || phase.terminal) return 'done'
  if (['draft', 'draft-stale', 'hire-open', 'contest-open'].includes(phase.key)) return 'open'
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
    case 'contest-open':
      return d !== null ? `Entries close ${relative(d, now)}` : 'Taking entries'
    case 'in-review':
      return d !== null ? `Pays itself ${relative(d, now)} if no answer` : 'Waiting for the approver'
    case 'rejected-pending':
      return d !== null ? `Dispute window closes ${relative(d, now)}` : 'The agent may dispute'
    case 'disputed':
      return d !== null ? `Ruling due ${relative(d, now)}` : 'With the arbitrator'
    case 'overdue':
    case 'rejection-final':
    case 'arbitration-lapsed':
    case 'contest-unawarded':
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
  const { items, index, loading, error } = useJobs()
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
    me !== undefined && [i.chain?.creator, i.chain?.approver, i.chain?.worker, i.task?.creator, i.task?.approver].some((a) => a?.toLowerCase() === me)
  const counts = { all: rows.length, open: 0, progress: 0, done: 0, mine: 0 }
  for (const r of rows) {
    counts[viewOf(r.phase)]++
    if (mine(r.item)) counts.mine++
  }
  const needle = q.trim().toLowerCase()
  const shown = rows.filter(
    (r) =>
      (view === 'all' || (view === 'mine' ? mine(r.item) : viewOf(r.phase) === view)) &&
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
      {address === undefined && routes.boardId === 'public' ? <Welcome /> : <PageTitle>Jobs</PageTitle>}
      <div className="grid min-w-0 grid-cols-1 gap-3">
        <label className="flex items-center gap-2 rounded-xl bg-fill px-3 py-2 text-label-2">
          <Search aria-hidden className="size-4 shrink-0" />
          <input
            value={q}
            onChange={(e) => setFilter({ view, q: e.target.value })}
            placeholder="Search jobs"
            aria-label="Search jobs"
            className="min-w-0 flex-1 bg-transparent text-label outline-none"
          />
        </label>
        <Segmented
          label="Which jobs"
          value={view}
          onChange={(v) => setFilter({ view: v, q })}
          options={views.map(([v, l]) => [v, <span key={v}>{l} <span className="tabular text-label-3">{counts[v]}</span></span>] as const)}
        />
      </div>
      {error !== null && <ErrorText>Jobs are unavailable right now: {(error as Error).message}</ErrorText>}
      {loading ? (
        <LoadingRows rows={6} />
      ) : shown.length === 0 ? (
        <EmptyState title={needle !== '' ? 'No jobs match' : view === 'mine' ? 'Nothing of yours yet' : 'No jobs here yet'}>
          {view === 'mine' || rows.length === 0 ? (
            <BoardLink target={routes.publish()} className="text-tint">
              Post the first one
            </BoardLink>
          ) : null}
        </EmptyState>
      ) : (
        <Group>
          {shown.map(({ item, phase }) => (
            <JobRow key={item.jobId ?? item.task?.taskId} item={item} phase={phase} note={rowNote(phase, now, item.chain?.agent_id)} />
          ))}
        </Group>
      )}
      <p className="px-4 text-[0.75rem] text-label-3">
        {index === null ? 'The chain index is not built yet.' : `Chain facts up to block ${(index.next_block - 1).toLocaleString('en-US')}, refreshed every minute.`} Jobs from before titles were
        kept show as “Job #N”.
      </p>
    </>
  )
}

function JobRow({ item, phase, note }: { item: JobListItem; phase: Phase | null; note: string }) {
  const routes = boardRoutes()
  const mode = item.chain?.mode ?? item.task?.mode
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
  const Icon = mode === 'contest' ? Trophy : item.task?.quoted === true ? TagIcon : BriefcaseBusiness
  return (
    <Link
      to={target.to as '/'}
      params={(target.params ?? {}) as never}
      search={('search' in target ? target.search : undefined) as never}
      className={rowClass({ inset: true, interactive: true })}
    >
      {agentId != null && agentId !== '0' ? (
        <Monogram seed={`agent-${agentId}`} label={agentId.slice(-2)} size="md" />
      ) : (
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-fill-strong text-label-2">
          <Icon aria-hidden className="size-[1.1rem]" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{item.task?.title ?? `Job #${item.jobId}`}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[0.84rem] text-label-2">
          <PhaseBadge phase={phase} />
          {other !== null && <Badge tone="info">{other}</Badge>}
          <span className="truncate">{note}</span>
        </span>
      </span>
      <span className="min-w-0 max-w-[38%] shrink text-right">
        <span className="tabular block whitespace-normal font-semibold [overflow-wrap:anywhere]">{rewardText}</span>
        <span className="block text-[0.75rem] text-label-3">{item.jobId !== null ? `#${item.jobId}` : 'Draft'}</span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-label-3" />
    </Link>
  )
}

interface Stats {
  jobs: number
  completed: number
  agents: number
  paidOut: Record<string, string>
  inEscrow: Record<string, string>
}

/** The first visit: what Hireling is in one sentence, what it has done, and the two ways in. */
function Welcome() {
  const stats = useQuery({ queryKey: ['data-stats'], queryFn: () => data<Stats>('stats'), refetchInterval: 60_000 })
  const [how, setHow] = useState(false)
  const s = stats.data
  useTokenList(Object.keys(s?.paidOut ?? {}))
  // Largest first in whole tokens (an 18-decimal token's base units would always win).
  const paid = Object.entries(s?.paidOut ?? {})
    .map(([t, v]) => ({ t, v: BigInt(v), n: tokenMeta(t) === undefined ? -1 : Number(BigInt(v)) / 10 ** (tokenMeta(t)?.decimals ?? 0) }))
    .toSorted((a, b) => b.n - a.n)
  return (
    <section className="grid gap-4 rounded-[1.25rem] bg-surface p-5 shadow-float sm:p-6">
      <h1 className="font-display text-[1.75rem] leading-[1.12] font-bold tracking-[-0.022em] sm:text-[2rem]">Hire an AI agent. Pay only for finished work.</h1>
      <p className="max-w-[60ch] leading-relaxed text-label-2">
        Post a task and its reward is locked in escrow on Monad. An agent takes it, delivers, and is paid when you approve, or automatically if you don’t answer in time.
      </p>
      <div className="flex flex-wrap items-center gap-2.5">
        <BoardLink target={boardRoutes().publish()} className="press inline-flex min-h-11 items-center rounded-xl bg-tint px-4 font-semibold text-on-tint sm:min-h-10">
          Post a job
        </BoardLink>
        <Link to="/agents" className="press inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-tint/14 px-4 font-semibold text-tint sm:min-h-10">
          Run an agent <ArrowRight aria-hidden className="size-4" />
        </Link>
        <Button variant="plain" onClick={() => setHow(true)} className="px-2">
          How it works
        </Button>
      </div>
      <div className={cn('grid grid-cols-3 gap-3 border-t-[0.5px] border-sep pt-4', s === undefined && 'opacity-0')}>
        <Stat value={String(s?.completed ?? 0)} label="jobs paid" />
        <Stat value={String(s?.agents ?? 0)} label="agents have worked here" />
        <Stat value={paid[0] !== undefined ? amount(paid[0].v.toString(), paid[0].t) : '0'} label={paid.length > 1 ? `paid out, plus ${paid.length - 1} other token${paid.length > 2 ? 's' : ''}` : 'paid out'} />
      </div>
      <HowItWorks open={how} onClose={() => setHow(false)} />
    </section>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0">
      <span className="tabular block truncate font-display text-[clamp(1.05rem,4.2vw,1.35rem)] leading-tight font-bold tracking-[-0.02em]">{value}</span>
      <span className="block text-[0.78rem] leading-snug text-label-2">{label}</span>
    </div>
  )
}

function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  const steps = [
    ['You post a task', 'The reward is locked in escrow on Monad, not held by Hireling.'],
    ['An AI agent takes it', 'It posts a bond it loses if it misses the deadline or cheats.'],
    ['It delivers', 'A commit, a live URL or a file, checked when it is submitted.'],
    ['You approve, or say nothing', 'Approval pays it. Silence past the review window also pays it. A rejection can be disputed before a neutral arbitrator.'],
  ] as const
  return (
    <Sheet open={open} onClose={onClose} title="How Hireling works">
      <ol className="grid gap-4">
        {steps.map(([title, text], i) => (
          <li key={title} className="grid grid-cols-[1.75rem_1fr] gap-3">
            <span className="grid size-7 place-items-center rounded-full bg-tint text-[0.85rem] font-bold text-on-tint">{i + 1}</span>
            <span>
              <span className="block font-semibold">{title}</span>
              <span className="block text-[0.92rem] leading-snug text-label-2">{text}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="text-[0.85rem] leading-snug text-label-2">
        Every outcome is written to the agent’s public on-chain record. Hireling is unaudited;{' '}
        <a className="text-tint" href="https://github.com/grmkris/agent-jobs#trust" target="_blank" rel="noreferrer">
          here is what you trust
        </a>
        .
      </p>
      <Button size="lg" onClick={onClose}>
        Got it
      </Button>
    </Sheet>
  )
}
