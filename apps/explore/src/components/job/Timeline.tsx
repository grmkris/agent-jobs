/**
 * A job's story as steps: what happened on-chain (from the indexer's timeline, with block times and transactions)
 * and what comes next (from the shared lifecycle model, with its deadline). Protocol bookkeeping events are folded
 * away; what remains is what a person would tell another: posted, started, delivered, approved, paid.
 */
import type { Phase } from '@agent-jobs/react'
import { AlertTriangle, Check, X } from 'lucide-react'
import { type Hex, hexToString } from 'viem'
import { amount, bond } from '../../format.ts'
import { Sentence } from '../Phase.tsx'
import { When } from '../Time.tsx'
import { TxLink, cn } from '../ui.tsx'

export interface TimelineEvent {
  name: string
  block: number
  logIndex: number
  txHash: string
  args: Record<string, string | number | boolean>
  at: number | null
}

type Mark = 'done' | 'now' | 'warn' | 'fail' | 'next'
interface Step {
  mark: Mark
  title: string
  sub?: string | undefined
  at?: number | null
  tx?: string
}

const VIOLATION = ['for no named fault', 'as not good enough', 'for faked evidence']
const TIMEOUT: Record<string, [string, Mark]> = {
  'review-window': ['Accepted: the review window closed without a decision', 'done'],
  'delivery-deadline': ['Closed: nothing was delivered in time', 'fail'],
  'dispute-window': ['The rejection stands: no dispute was filed', 'fail'],
  'arbitration-window': ['Refunded: the arbitrator did not rule in time', 'warn'],
}

const reason = (v: unknown) => {
  try {
    return hexToString(v as Hex).replace(/\0+$/, '')
  } catch {
    return String(v)
  }
}

export interface TimelineJob {
  token: string | null
  reward: string | null
  workerBond: string | null
  agentId: string | null
  deliveryDeadline: number | null
  creator: string | null
}

function pastSteps(events: TimelineEvent[], job: TimelineJob): Step[] {
  const agent = job.agentId !== null ? `Agent #${job.agentId}` : 'The agent'
  const steps: Step[] = []
  for (const e of events) {
    const a = e.args
    const at = e.at
    const tx = e.txHash
    switch (e.name) {
      case 'Published':
        steps.push({ mark: 'done', title: `Posted · ${amount(String(a.reward ?? job.reward ?? '0'), job.token)} locked in escrow`, at, tx })
        break
      case 'Activated':
        steps.push({ mark: 'done', title: `Agent #${String(a.agentId)} started`, sub: job.workerBond !== null && job.workerBond !== '0' ? `Posted its ${bond(job.workerBond)} bond` : undefined, at, tx })
        break
      case 'Awarded':
        steps.push({ mark: 'done', title: `Agent #${String(a.agentId)}'s entry won`, at, tx })
        break
      case 'JobSubmitted': {
        const late = job.deliveryDeadline !== null && at !== null && at > job.deliveryDeadline
        steps.push({ mark: late ? 'warn' : 'done', title: late ? 'Delivered after the deadline' : 'Delivered', at, tx })
        break
      }
      case 'EvidenceAttached':
        steps.push({ mark: Number(a.conclusion) === 1 ? 'done' : 'warn', title: Number(a.conclusion) === 1 ? 'Required check passed' : 'Required check failed', sub: 'Signed attestation of the GitHub check run', at, tx })
        break
      case 'Rejected':
        steps.push({ mark: 'warn', title: `Rejected ${VIOLATION[Number(a.violation)] ?? ''}`.trim(), at, tx })
        break
      case 'Disputed':
        steps.push({ mark: 'warn', title: `${agent} disputed the rejection`, at, tx })
        break
      case 'Ruled':
        steps.push({
          mark: a.forWorker === true ? 'done' : 'fail',
          title: a.forWorker === true ? `The arbitrator ruled for ${agent}` : 'The arbitrator ruled for the creator',
          sub: a.slashLoser === true ? (a.forWorker === true ? "Bad-faith rejection: the creator's bond is burned" : "The agent's bond is burned") : undefined,
          at,
          tx,
        })
        break
      case 'Accepted':
        // An award completes through the same call; its own step says so.
        if (!steps.some((s) => s.title.endsWith('entry won'))) steps.push({ mark: 'done', title: 'Approved', at, tx })
        break
      case 'TimedOut': {
        const [title, mark] = TIMEOUT[reason(a.reason)] ?? [`Timed out (${reason(a.reason)})`, 'warn']
        steps.push({ mark, title, at, tx })
        break
      }
      case 'PaymentReleased':
        steps.push({ mark: 'done', title: `${amount(String(a.amount), job.token)} paid to ${agent}`, at, tx })
        break
      case 'RewardSettled':
        steps.push({ mark: 'done', title: `${amount(String(a.amount), job.token)} returned to the creator`, at, tx })
        break
      case 'BondBurned':
        steps.push({ mark: 'fail', title: `${Number(a.side) === 0 ? "The creator's" : "The agent's"} ${bond(String(a.amount))} bond burned`, at, tx })
        break
      case 'Cancelled':
        steps.push({ mark: 'fail', title: 'Cancelled before anyone started', at, tx })
        break
      case 'ContestExpired':
        steps.push({ mark: 'fail', title: 'Closed without a winner', at, tx })
        break
      case 'JobExpired':
        steps.push({ mark: 'fail', title: 'Expired and refunded', at, tx })
        break
      case 'FeedbackRecorded':
        steps.push({ mark: 'done', title: `Rated "${String(a.tag)}" on ${agent}'s public record`, at, tx })
        break
      default:
        break
    }
  }
  return steps
}

/** What is still to come, from the phase the job is in. */
function nextSteps(phase: Phase | null): Step[] {
  if (phase === null || phase.terminal) return []
  const now = (title: string): Step => ({ mark: 'now', title, at: phase.deadline })
  switch (phase.key) {
    case 'draft':
    case 'draft-stale':
      return [now('Publish: the reward is locked in escrow'), { mark: 'next', title: 'An agent starts' }, { mark: 'next', title: 'Delivered and reviewed' }, { mark: 'next', title: 'Paid' }]
    case 'hire-open':
      return [now('Taking applications'), { mark: 'next', title: 'An agent starts' }, { mark: 'next', title: 'Delivered and reviewed' }, { mark: 'next', title: 'Paid' }]
    case 'contest-open':
      return [now('Taking entries'), { mark: 'next', title: 'The best entry is paid' }]
    case 'active':
      return [now('Working on it'), { mark: 'next', title: 'Delivered and reviewed' }, { mark: 'next', title: 'Paid' }]
    case 'in-review':
      return [now('In review'), { mark: 'next', title: 'Paid' }]
    case 'rejected-pending':
      return [now('Dispute window'), { mark: 'next', title: 'Refund, or arbitration if disputed' }]
    case 'disputed':
      return [now('The arbitrator decides'), { mark: 'next', title: 'Paid or refunded' }]
    default:
      return [{ mark: 'now', title: phase.label }]
  }
}

export function Timeline({ events, job, phase }: { events: TimelineEvent[]; job: TimelineJob; phase: Phase | null }) {
  const steps = [...pastSteps(events, job), ...nextSteps(phase)]
  if (steps.length === 0) return null
  return (
    <ol className="grid rounded-xl bg-surface px-4 pt-3.5 pb-1">
      {steps.map((s, i) => (
        <li key={`${i}-${s.title}`} className="relative grid min-w-0 grid-cols-[1.375rem_minmax(0,1fr)] gap-x-3 pb-4 sm:grid-cols-[1.375rem_minmax(0,1fr)_auto]">
          {i < steps.length - 1 && <span aria-hidden className={cn('absolute top-6 bottom-0 left-[0.625rem] w-0.5', s.mark === 'done' ? 'bg-tint/45' : 'bg-sep')} />}
          <Dot mark={s.mark} />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span className={cn('block leading-snug font-medium', s.mark === 'next' && 'font-normal text-label-2')}>{s.title}</span>
            {s.sub !== undefined && <span className="block text-[0.82rem] text-label-2">{s.sub}</span>}
            {s.mark === 'now' && phase !== null && phase.next.length > 0 && (
              <span className="block text-[0.82rem] text-label-2">
                <Sentence parts={phase.next} />
              </span>
            )}
            {s.tx !== undefined && (
              <span className="block">
                <TxLink hash={s.tx} />
              </span>
            )}
          </span>
          <span className="col-start-2 min-w-0 text-[0.8rem] text-label-2 sm:col-start-auto sm:text-right">{s.at !== undefined && s.at !== null && <When at={s.at} show={s.mark === 'now' ? 'relative' : 'time'} />}</span>
        </li>
      ))}
    </ol>
  )
}

function Dot({ mark }: { mark: Mark }) {
  const base = 'relative z-10 mt-0.5 grid size-[1.375rem] place-items-center rounded-full'
  if (mark === 'done') return <span className={cn(base, 'bg-tint text-on-tint')}><Check aria-hidden className="size-3" strokeWidth={3.5} /></span>
  if (mark === 'fail') return <span className={cn(base, 'bg-bad text-background')}><X aria-hidden className="size-3" strokeWidth={3.5} /></span>
  if (mark === 'warn') return <span className={cn(base, 'bg-warn text-background')}><AlertTriangle aria-hidden className="size-3" strokeWidth={3} /></span>
  if (mark === 'now') return <span className={cn(base, 'bg-surface ring-2 ring-tint ring-inset')}><span className="size-2 rounded-full bg-tint" /></span>
  return <span className={cn(base, 'bg-fill-strong')} />
}
