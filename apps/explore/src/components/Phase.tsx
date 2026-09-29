/**
 * Where a job stands, as the shared lifecycle model (`@agent-jobs/react` → SDK `lifecycle`) says: a pill, and the
 * "what happens next" sentence with its deadline as a live time. List rows use the indexer's facts; a job page adds
 * the board's windows (review, dispute, arbitration) for exact deadlines.
 */
import { type LifecycleInput, type Phase, type Segment, lifecycle, lifecycleFromIndexed } from '@agent-jobs/react'
import type { ChainJob, TaskIndexEntry } from '../api.ts'
import { When } from './Time.tsx'
import { Badge } from './ui.tsx'

/** Lifecycle input for a list item: the chain row when indexed, else the board's frozen offer (a draft). */
export function lifecycleInput(chain: ChainJob | undefined, task: TaskIndexEntry | undefined): LifecycleInput | null {
  if (chain !== undefined) return lifecycleFromIndexed(chain)
  if (task === undefined) return null
  return {
    mode: task.mode,
    status: task.jobId === null ? 'awaiting-publish' : 'unknown',
    deliveryDeadline: task.deliveryDeadline,
    selectionDeadline: task.selectionDeadline,
    workerBond: task.workerBond,
    parties: { creator: task.creator, approver: task.approver },
  }
}

export function phaseOf(chain: ChainJob | undefined, task: TaskIndexEntry | undefined, viewer: string | undefined, now: number): Phase | null {
  const input = lifecycleInput(chain, task)
  return input === null ? null : lifecycle(input, viewer ?? null, now)
}

export function PhaseBadge({ phase }: { phase: Phase | null }) {
  if (phase === null) return <Badge>…</Badge>
  return <Badge tone={phase.tone}>{phase.label}</Badge>
}

/** A lifecycle sentence with its times rendered live in the reader's time zone. */
export function Sentence({ parts }: { parts: Segment[] }) {
  return (
    <>
      {parts.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <When key={i} at={p.time} show="time" />))}
    </>
  )
}
