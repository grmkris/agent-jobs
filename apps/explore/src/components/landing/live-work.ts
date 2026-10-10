import type { FeedEvent } from '../../activity-feed.ts'
import type { JobListItem } from '../../job-list.ts'
import { phaseOf } from '../Phase.tsx'

export function boardActivityText(completed: number, agents: number): string {
  const jobs = `${completed.toLocaleString()} ${completed === 1 ? 'job' : 'jobs'} completed`
  const workers = `${agents.toLocaleString()} ${agents === 1 ? 'agent has' : 'agents have'} worked here`
  return `${jobs} · ${workers}`
}

/** The landing features available work, work under way and successful delivery, by the lifecycle Activity uses. */
export function liveWorkItems(items: readonly JobListItem[], now: number): JobListItem[] {
  return items.filter((item) => {
    if (item.jobId === null) return false
    const status = item.chain?.status
    if (status === undefined) return false
    if (status === 'cancelled' || status === 'expired') return false
    const phase = phaseOf(item.chain, item.task, undefined, now)
    if (phase === null) return false
    if (status === 'completed' || phase.key === 'completed') return true
    if (status === 'open') return phase.key === 'hire-open'
    if (status === 'active') return ['active', 'overdue'].includes(phase.key)
    if (status === 'submitted') return ['in-review', 'accepted-by-silence', 'delivered-late'].includes(phase.key)
    return false
  })
}

/** How many events the landing shows: a glance at the board, with Activity one link away. */
const LANDING_EVENTS = 6

/**
 * The landing's slice of Activity, newest first: steps on the jobs `liveWorkItems` features (nothing cancelled or
 * expired), and quote requests still open.
 */
export function landingEvents(
  events: readonly FeedEvent[],
  items: readonly JobListItem[],
  now: number,
  limit = LANDING_EVENTS,
): FeedEvent[] {
  const featured = new Set(liveWorkItems(items, now).map((item) => item.jobId))
  return events.filter((e) => (e.jobId === null ? e.job?.bucket === 'open' : featured.has(e.jobId))).slice(0, limit)
}
