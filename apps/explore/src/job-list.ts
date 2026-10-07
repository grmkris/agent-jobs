/**
 * The single Jobs list: on-chain jobs and quote requests as one set of rows, which filter each belongs to, which
 * deadline its countdown runs to, and the order (open work first, soonest deadline first, then newest).
 */
import type { Phase } from '@sidequest/react'
import type { ChainJob, QuoteRequest, TaskIndexEntry } from './api.ts'

export interface JobListItem {
  jobId: string | null
  task: TaskIndexEntry | undefined
  chain: ChainJob | undefined
  /** A quote request nobody has picked yet: nothing is escrowed, there is no job. */
  request?: QuoteRequest
}

export type View = 'all' | 'open' | 'progress' | 'done' | 'mine'

/** Which list a phase belongs in: open to agents, under way, or finished. */
export function viewOf(phase: Phase | null): Exclude<View, 'all' | 'mine'> | null {
  if (phase === null) return null
  if (phase.key === 'quotes-open') return 'open'
  if (phase.key === 'quotes-closed' || phase.key === 'quote-picked') return 'done'
  if (phase.terminal) return 'done'
  if (['draft', 'draft-stale', 'hire-open'].includes(phase.key)) return 'open'
  return 'progress'
}

/**
 * A closed request reads "Closed · no pick" to everyone but its poster, who can still pick one of its quotes.
 */
export function listPhase(phase: Phase): Phase {
  return phase.key === 'quotes-closed' && !phase.roles.includes('creator') ? { ...phase, label: 'Closed · no pick' } : phase
}

/** The countdown a row shows: what happens at the deadline, and what it reads once passed. */
export interface RowCountdown {
  verb: string
  to: number
  passed: string
}

const COUNTDOWN: Partial<Record<Phase['key'], { verb: string; passed: string }>> = {
  'quotes-open': { verb: 'closes', passed: 'closed' },
  'hire-open': { verb: 'due', passed: 'overdue' },
  active: { verb: 'due', passed: 'overdue' },
  'in-review': { verb: 'pays in', passed: 'payable' },
  'rejected-pending': { verb: 'dispute closes', passed: 'closed' },
  disputed: { verb: 'ruling due', passed: 'overdue' },
}

export function rowCountdown(phase: Phase | null): RowCountdown | null {
  if (phase === null || phase.deadline === null) return null
  const words = COUNTDOWN[phase.key]
  return words === undefined ? null : { ...words, to: phase.deadline }
}

/** When the row's work was posted: the request's or the offer's board record, unix seconds. */
export const postedAt = (item: JobListItem): number | null => item.request?.createdAt ?? item.task?.createdAt ?? null

/**
 * Posted within the last minute, by a clock that may be floored to the minute (or a little behind the board's): reads
 * "just now", never "in 31 s".
 */
export const postedJustNow = (posted: number, now: number): boolean => now - posted < 60

/** Who posted it: the request's or the offer's creator wallet, else the chain listing's. */
export const posterOf = (item: JobListItem): string | null => item.request?.creator ?? item.task?.creator ?? item.chain?.creator ?? null

export const titleOf = (item: JobListItem): string => item.request?.title ?? item.task?.title ?? ''

export const tagsOf = (item: JobListItem): readonly string[] => item.request?.tags ?? item.task?.tags ?? []

export const rowKey = (item: JobListItem): string => item.request !== undefined ? `request:${item.request.requestId}` : item.jobId ?? `task:${item.task?.taskId}`

/** Open work first, the soonest deadline first; then everything else, newest first. */
export function sortRows<T extends { item: JobListItem; phase: Phase | null }>(rows: readonly T[]): T[] {
  const open = (r: T) => viewOf(r.phase) === 'open'
  return rows.toSorted((a, b) => {
    if (open(a) !== open(b)) return open(a) ? -1 : 1
    if (open(a)) {
      const by = (a.phase?.deadline ?? Infinity) - (b.phase?.deadline ?? Infinity)
      if (by !== 0 && !Number.isNaN(by)) return by
    }
    const newer = (postedAt(b.item) ?? 0) - (postedAt(a.item) ?? 0)
    if (newer !== 0) return newer
    return Number(b.item.jobId ?? 1e9) - Number(a.item.jobId ?? 1e9)
  })
}
