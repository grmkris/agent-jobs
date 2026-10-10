/**
 * A job's four milestones as its page's side column shows them: posted, hired, delivered and paid, each with when it
 * happened, read from the chain's timeline. A job that left the path ends at what happened instead (rejected, in
 * dispute, ruled for the creator, cancelled, expired, refunded); the full story, transactions and all, is the timeline.
 */
import type { TimelineEvent } from './components/job/Timeline.tsx'

export interface Milestone {
  label: string
  state: 'done' | 'todo' | 'failed' | 'closed'
  at: number | null
}

/** Holding's `Outcome` of a settled reward that paid the agent. */
const PAID = 1

const paidOut = (e: TimelineEvent) =>
  e.name === 'PaymentReleased' ||
  (e.name === 'RewardSettled' && Number(e.args.outcome) === PAID && String(e.args.amount) !== '0')

const PATH: readonly { label: string; reached: (e: TimelineEvent) => boolean }[] = [
  { label: 'Posted', reached: (e) => e.name === 'Published' },
  { label: 'Hired', reached: (e) => e.name === 'Activated' },
  { label: 'Delivered', reached: (e) => e.name === 'JobSubmitted' },
  { label: 'Paid', reached: paidOut },
]

/** How a job that did not pay ended, from the event that ended it. */
function ending(e: TimelineEvent): Omit<Milestone, 'at'> | null {
  switch (e.name) {
    case 'Rejected':
      return { label: 'Rejected', state: 'failed' }
    case 'Disputed':
      return { label: 'In dispute', state: 'failed' }
    case 'Ruled':
      return e.args.forWorker === true ? null : { label: 'Ruled for the creator', state: 'failed' }
    case 'Cancelled':
      return { label: 'Cancelled', state: 'closed' }
    case 'JobExpired':
      return { label: 'Expired', state: 'closed' }
    case 'RewardSettled':
      return Number(e.args.outcome) === PAID ? null : { label: 'Refunded', state: 'closed' }
    default:
      return null
  }
}

export function milestones(events: readonly TimelineEvent[]): Milestone[] {
  const out: Milestone[] = []
  for (const stop of PATH) {
    const hit = events.find(stop.reached)
    if (hit !== undefined) {
      out.push({ label: stop.label, state: 'done', at: hit.at })
      continue
    }
    const last = events.findLast((e) => ending(e) !== null)
    const end = last === undefined ? null : ending(last)
    if (last !== undefined && end !== null) return [...out, { ...end, at: last.at }]
    out.push({ label: stop.label, state: 'todo', at: null })
  }
  return out
}
