import type { Phase } from '@sidequest/react'
import type { JobTag } from '@sidequest/sdk'
/**
 * The Activity page's model: every job and open quote request on the board as one set, each in one bucket by where it
 * stands, filtered as a whole. Both row styles (one row per event, one per job) show what this set lets through, so a
 * filter and its count never depend on how many pages of activity have loaded.
 */
import type { QuoteRequest } from './api.ts'
import { readTags } from './components/JobFilters.tsx'
import { type JobListItem, postedAt, posterOf, rowKey, rowPhase, tagsOf, titleOf } from './job-list.ts'
import type { ActivityStep, LiveItem, Party } from './live-activity.ts'

export type Bucket = 'open' | 'progress' | 'review' | 'paid' | 'disputes' | 'closed'
export type StepFilter = 'all' | Bucket
export const STEP_FILTERS: readonly StepFilter[] = ['all', 'open', 'progress', 'review', 'paid', 'disputes', 'closed']

export interface FeedJob {
  key: string
  item: JobListItem
  phase: Phase | null
  bucket: Bucket | null
  /** The agent behind the posting wallet, when this viewer can name it. */
  posterAgent: string | null
  /** The hired worker's Agent ID. */
  workerAgent: string | null
  /** The quote request this job was picked from. */
  requested: QuoteRequest | null
  /** This job's steps from the activity pages loaded so far, oldest first. */
  steps: readonly ActivityStep[]
  /** The newest loaded step's time, else when the work was posted; `stepped` says which. */
  latestAt: number | null
  stepped: boolean
}

export interface FeedFilter {
  step: StepFilter
  tags: readonly JobTag[]
  q: string
  /** An Agent ID: work it posted or took. */
  agent: string | null
  mine: boolean
  /** Every step as its own row, instead of each job once at its newest step. A way of reading, not a filter. */
  everyStep: boolean
}

export const NO_FILTER: FeedFilter = { step: 'all', tags: [], q: '', agent: null, mine: false, everyStep: false }

const BUCKET: Partial<Record<Phase['key'], Bucket>> = {
  'quotes-open': 'open',
  'hire-open': 'open',
  active: 'progress',
  overdue: 'progress',
  'in-review': 'review',
  'accepted-by-silence': 'review',
  'delivered-late': 'review',
  completed: 'paid',
  'rejected-pending': 'disputes',
  disputed: 'disputes',
  'rejection-final': 'disputes',
  'arbitration-lapsed': 'disputes',
  rejected: 'disputes',
  cancelled: 'closed',
  expired: 'closed',
  'quotes-closed': 'closed',
  'quote-picked': 'closed',
  'hire-lapsed': 'closed',
}

/** Where a job stands, in the filter's words. Drafts and unreadable jobs belong to no bucket. */
export function bucketOf(phase: Phase | null): Bucket | null {
  if (phase === null) return null
  if (phase.key === 'collect' || phase.key === 'payout-deferred')
    return phase.beneficiary === 'worker' ? 'paid' : 'closed'
  return BUCKET[phase.key] ?? null
}

/** Each job's steps that have a time, once each, oldest first. */
function stepsByJob(steps: readonly ActivityStep[]): Map<string, ActivityStep[]> {
  const out = new Map<string, ActivityStep[]>()
  const seen = new Set<string>()
  for (const s of steps.toSorted((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
    const key = stepKey(s)
    if (s.at === null || seen.has(key)) continue
    seen.add(key)
    out.set(s.jobId, [...(out.get(s.jobId) ?? []), s])
  }
  return out
}

const stepKey = (s: ActivityStep) => `${s.txHash}:${s.jobId}:${s.step}`

interface FeedInput {
  /** `useJobs()` rows: chain jobs with their board offers, and unpublished offers. */
  items: readonly JobListItem[]
  requests: readonly QuoteRequest[]
  steps: readonly ActivityStep[]
  /** Poster wallet (lower case) → Agent ID. */
  posters: ReadonlyMap<string, string>
  viewer: string | undefined
  now: number
}

/** The agent behind the work's poster: the request's own claim, else the wallet's known agent. */
function posterAgentOf(item: JobListItem, requested: QuoteRequest | null, posters: ReadonlyMap<string, string>) {
  // The board records the posting agent (ADR-0019); older posts fall back to the wallet's known agent.
  const claimed = item.request?.creatorAgentId ?? item.task?.creatorAgentId ?? requested?.creatorAgentId
  if (claimed != null) return claimed
  const wallet = posterOf(item)
  return wallet === null ? null : (posters.get(wallet.toLowerCase()) ?? null)
}

const workerAgentOf = (item: JobListItem) => {
  const id = item.chain?.agent_id
  return id == null || id === '0' ? null : id
}

function feedJob(
  item: JobListItem,
  requested: QuoteRequest | null,
  steps: readonly ActivityStep[],
  input: FeedInput,
): FeedJob {
  const phase = rowPhase(item, input.viewer, input.now)
  const last = steps.at(-1)
  return {
    key: rowKey(item),
    item,
    phase,
    bucket: bucketOf(phase),
    posterAgent: posterAgentOf(item, requested, input.posters),
    workerAgent: workerAgentOf(item),
    requested,
    steps,
    latestAt: last?.at ?? postedAt(item) ?? requested?.createdAt ?? null,
    stepped: last !== undefined,
  }
}

/**
 * Every published job and every quote request nobody has picked, newest activity first. A picked request folds into
 * the job it became; an offer never published is a draft, listed separately for its creator.
 */
export function feedJobs(input: FeedInput): FeedJob[] {
  const picked = new Map(input.requests.flatMap((r) => (r.taskId == null ? [] : [[r.taskId, r] as const])))
  const steps = stepsByJob(input.steps)
  const jobs = input.items
    .filter((item) => item.jobId !== null)
    .map((item) =>
      feedJob(
        item,
        item.task === undefined ? null : (picked.get(item.task.taskId) ?? null),
        steps.get(item.jobId ?? '') ?? [],
        input,
      ),
    )
  const open = input.requests
    .filter((r) => r.taskId == null)
    .map((request) => feedJob({ jobId: null, task: undefined, chain: undefined, request }, null, [], input))
  return [...jobs, ...open].toSorted(
    (a, b) => (b.latestAt ?? 0) - (a.latestAt ?? 0) || Number(b.item.jobId ?? 0) - Number(a.item.jobId ?? 0),
  )
}

/** How far a job got along posted → hired → delivered → paid (0 for a request), and how it left that path. */
export interface Progress {
  reached: number
  ending: 'disputed' | 'closed' | null
}

const REACHED: Readonly<Record<Bucket, number>> = { open: 1, progress: 2, review: 3, paid: 4, disputes: 3, closed: 1 }

export function progressOf(job: FeedJob): Progress {
  const { bucket } = job
  if (job.item.jobId === null) return { reached: 0, ending: bucket === 'closed' ? 'closed' : null }
  if (bucket === null) return { reached: 1, ending: null }
  if (bucket === 'closed') return { reached: job.item.chain?.worker == null ? 1 : 2, ending: 'closed' }
  return { reached: REACHED[bucket], ending: bucket === 'disputes' ? 'disputed' : null }
}

/** Offers this wallet froze but never published: nothing is escrowed, so only its creator sees them. */
export const draftsOf = (items: readonly JobListItem[], viewer: string | undefined): JobListItem[] =>
  viewer === undefined
    ? []
    : items.filter((i) => i.jobId === null && i.task?.creator.toLowerCase() === viewer.toLowerCase())

/** Whether this wallet posted, approves or works the job, or asked for its quotes. */
export function involves(job: FeedJob, wallet: string): boolean {
  const { request, chain, task } = job.item
  const me = wallet.toLowerCase()
  return [request?.creator, chain?.creator, chain?.approver, chain?.worker, task?.creator, task?.approver].some(
    (a) => a?.toLowerCase() === me,
  )
}

function matchesText(job: FeedJob, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (needle === '') return true
  return titleOf(job.item).toLowerCase().includes(needle) || job.item.jobId === needle.replace(/^#/, '')
}

function matchesPeople(job: FeedJob, f: FeedFilter, viewer: string | undefined): boolean {
  if (f.mine && (viewer === undefined || !involves(job, viewer))) return false
  return f.agent === null || job.posterAgent === f.agent || job.workerAgent === f.agent
}

export function matches(job: FeedJob, f: FeedFilter, viewer: string | undefined): boolean {
  if (f.step !== 'all' && job.bucket !== f.step) return false
  if (f.tags.length > 0 && !tagsOf(job.item).some((tag) => f.tags.includes(tag))) return false
  return matchesPeople(job, f, viewer) && matchesText(job, f.q)
}

/** Whether anything narrows the feed beyond everything. */
export const filtering = (f: FeedFilter): boolean =>
  f.step !== 'all' || f.tags.length > 0 || f.q.trim() !== '' || f.agent !== null || f.mine

/** How many jobs each step filter would show with the other filters as they are. */
export function bucketCounts(
  jobs: readonly FeedJob[],
  f: FeedFilter,
  viewer: string | undefined,
): Record<StepFilter, number> {
  const counts: Record<StepFilter, number> = {
    all: 0,
    open: 0,
    progress: 0,
    review: 0,
    paid: 0,
    disputes: 0,
    closed: 0,
  }
  for (const job of jobs) {
    if (!matches(job, { ...f, step: 'all' }, viewer)) continue
    counts.all++
    if (job.bucket !== null) counts[job.bucket]++
  }
  return counts
}

/** The old Jobs list's `view=` links (feed, Telegram, bookmarks, the /quotes redirect) in the feed's terms. */
const LEGACY_VIEW: Readonly<Record<string, Partial<FeedFilter>>> = {
  open: { step: 'open' },
  progress: { step: 'progress' },
  done: { step: 'paid' },
  mine: { mine: true },
}

const STEPS: ReadonlySet<string> = new Set(STEP_FILTERS)
const isStep = (value: string | null): value is StepFilter => value !== null && STEPS.has(value)

export function readFilter(p: URLSearchParams): FeedFilter {
  const step = p.get('step')
  const agent = p.get('agent')
  return {
    step: isStep(step) ? step : 'all',
    tags: readTags(p.get('tags')),
    q: p.get('q') ?? '',
    agent: agent !== null && /^\d+$/.test(agent) ? agent : null,
    mine: p.get('mine') === '1',
    everyStep: p.get('steps') === 'all',
    ...LEGACY_VIEW[p.get('view') ?? ''],
  }
}

/** The filter into the URL's parameters, leaving any other parameter as it is. */
export function writeFilter(f: FeedFilter, p: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(p)
  const set = (key: string, value: string | null) => (value === null ? out.delete(key) : out.set(key, value))
  out.delete('view')
  set('step', f.step === 'all' ? null : f.step)
  set('tags', f.tags.length === 0 ? null : f.tags.toSorted().join(','))
  set('q', f.q === '' ? null : f.q)
  set('agent', f.agent)
  set('mine', f.mine ? '1' : null)
  set('steps', f.everyStep ? 'all' : null)
  return out
}

export interface FeedEvent extends LiveItem {
  /** The job or request it happened to; undefined for a job this page has no record of. */
  job: FeedJob | undefined
}

/** Who posted the work: its agent when this page can name one, else the posting wallet. */
export function posterParty(job: FeedJob | undefined): Party | null {
  if (job === undefined) return null
  if (job.posterAgent !== null) return { agent: job.posterAgent }
  const wallet = posterOf(job.item)
  return wallet === null ? null : { wallet }
}

/** A posting or request's sentence opens with its poster: the agent, or the wallet when no agent names it. */
function posterFields(job: FeedJob | undefined): Pick<LiveItem, 'agentId' | 'wallet'> {
  const party = posterParty(job)
  if (party === null) return { agentId: null }
  return 'agent' in party ? { agentId: party.agent } : { agentId: null, wallet: party.wallet }
}

function stepEvent(s: ActivityStep & { at: number }, job: FeedJob | undefined): FeedEvent {
  return {
    key: stepKey(s),
    kind: s.step,
    at: s.at,
    jobId: s.jobId,
    requestId: null,
    title: (job === undefined ? '' : titleOf(job.item)) || `job #${s.jobId}`,
    // The chain names only the worker; a posting is the poster's.
    ...(s.step === 'posted' ? posterFields(job) : { agentId: s.agentId }),
    ...(s.token === undefined || s.amount === undefined ? {} : { token: s.token, amount: s.amount }),
    job,
  }
}

function requestEvent(job: FeedJob): FeedEvent[] {
  const r = job.item.request ?? job.requested
  if (r === undefined || r === null) return []
  return [
    {
      key: `request:${r.requestId}`,
      kind: 'requested',
      at: r.createdAt,
      jobId: job.item.jobId,
      requestId: r.requestId,
      title: r.title,
      ...posterFields(job),
      job,
    },
  ]
}

/**
 * The feed as events, newest first: the loaded job steps and every quote request. While older pages of steps remain
 * (`more`), a request older than the oldest loaded step waits for its page, so loading more never reshuffles the top.
 */
export function feedEvents(steps: readonly ActivityStep[], jobs: readonly FeedJob[], more: boolean): FeedEvent[] {
  const byJob = new Map(jobs.flatMap((j) => (j.item.jobId === null ? [] : [[j.item.jobId, j] as const])))
  const seen = new Set<string>()
  const fromSteps = steps.flatMap((s) => {
    if (s.at === null || seen.has(stepKey(s))) return []
    seen.add(stepKey(s))
    return [stepEvent({ ...s, at: s.at }, byJob.get(s.jobId))]
  })
  const oldest = more ? Math.min(...fromSteps.map((e) => e.at)) : -Infinity
  const fromRequests = jobs.flatMap(requestEvent).filter((e) => e.at >= oldest)
  return [...fromSteps, ...fromRequests].toSorted((a, b) => b.at - a.at)
}

/** The events whose job the filter lets through; an event on a job this page cannot read shows only unfiltered. */
export const visibleEvents = (events: readonly FeedEvent[], f: FeedFilter, viewer: string | undefined): FeedEvent[] =>
  events.filter((e) => (e.job === undefined ? !filtering(f) : matches(e.job, f, viewer)))

/** Which job or request an event belongs to: events of one share a key. */
const groupKey = (e: FeedEvent) => e.job?.key ?? (e.jobId === null ? `request:${e.requestId}` : e.jobId)

/**
 * Each job once, at its newest event (the events come newest first): a job's earlier steps are told by its track, so
 * the feed reads as one line per piece of work.
 */
export function newestPerJob(events: readonly FeedEvent[]): FeedEvent[] {
  const seen = new Set<string>()
  return events.filter((e) => {
    const key = groupKey(e)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** One stop of a job's track. `after` is the time since the stop before it, when both are known. */
export interface TrackStop {
  label: string
  state: 'done' | 'todo' | 'failed' | 'closed'
  at: number | null
  after: number | null
}

const TRACK = [
  { label: 'Posted', step: 'posted' },
  { label: 'Hired', step: 'hired' },
  { label: 'Delivered', step: 'delivered' },
  { label: 'Paid', step: 'completed' },
] as const

/**
 * A job's way along posted → hired → delivered → paid: each stop done or still ahead, with the time each step took
 * from the loaded steps. A job that left the path ends at a red Disputed or a grey Closed in place of the stop it
 * missed. Requests have no track yet.
 */
export function trackOf(job: FeedJob): TrackStop[] {
  const { reached, ending } = progressOf(job)
  if (reached === 0) return []
  const at = (step: string) => job.steps.find((s) => s.step === step)?.at ?? null
  const stops: TrackStop[] = []
  for (const [i, stage] of TRACK.entries()) {
    const when = at(stage.step)
    const before = stops.at(-1)?.at ?? null
    const after = when !== null && before !== null ? when - before : null
    if (i < reached) stops.push({ label: stage.label, state: 'done', at: when, after })
    else if (ending === 'disputed') return [...stops, { label: 'Disputed', state: 'failed', at: null, after: null }]
    else if (ending === 'closed') return [...stops, { label: 'Closed', state: 'closed', at: null, after: null }]
    else stops.push({ label: stage.label, state: 'todo', at: null, after: null })
  }
  return stops
}
