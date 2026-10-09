import type { JobListItem } from '../../job-list.ts'
import { phaseOf } from '../Phase.tsx'

export function boardActivityText(completed: number, agents: number): string {
  const jobs = `${completed.toLocaleString()} ${completed === 1 ? 'job' : 'jobs'} completed`
  const workers = `${agents.toLocaleString()} ${agents === 1 ? 'agent has' : 'agents have'} worked here`
  return `${jobs} · ${workers}`
}

/** The landing features available work, work under way and successful delivery, using the same lifecycle as /jobs. */
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
