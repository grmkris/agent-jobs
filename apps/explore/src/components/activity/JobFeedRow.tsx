import { BriefcaseBusiness, Tag as TagIcon } from 'lucide-react'
import { type FeedJob, type Progress, progressOf } from '../../activity-feed.ts'
import { currentBoardId } from '../../api.ts'
import { jobTarget, titleOf } from '../../job-list.ts'
import type { ActivityStep } from '../../live-activity.ts'
import { cn } from '../../lib/cn.ts'
import { AgentLink } from '../agent/AgentChip.tsx'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { BoardLink } from '../BoardLink.tsx'
import { When } from '../Time.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { FeedDetails } from './FeedDetails.tsx'
import { StretchedRow } from './StretchedRow.tsx'

const STAGES = ['Posted', 'Hired', 'Delivered', 'Paid'] as const

/** The last step, in a word or two. */
const STEP_WORDS: Readonly<Record<ActivityStep['step'], string>> = {
  posted: 'Posted',
  hired: 'Hired',
  delivered: 'Delivered',
  completed: 'Paid',
  rejected: 'Delivery rejected',
  disputed: 'Disputed',
  ruled: 'Arbitrator ruled',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

/** Four segments along posted → hired → delivered → paid; the step it left the path on reads red or grey. */
function ProgressBar({ progress }: { progress: Progress }) {
  return (
    <span aria-hidden className="inline-flex items-center gap-0.5">
      {STAGES.map((stage, i) => (
        <span
          key={stage}
          className={cn(
            'h-1.5 w-3.5 rounded-full',
            i < progress.reached ? 'bg-primary' : 'bg-muted-foreground/20',
            i === progress.reached && progress.ending === 'disputed' && 'bg-destructive-text',
            i === progress.reached && progress.ending === 'closed' && 'bg-muted-foreground/50',
          )}
        />
      ))}
    </span>
  )
}

/** What happened last and when; before any step has loaded, when the work was posted. */
function Latest({ job }: { job: FeedJob }) {
  const last = job.steps.at(-1)
  const token = job.item.chain?.token
  if (last === undefined)
    return (
      <span>
        {job.item.request !== undefined ? 'Asked for quotes' : 'Posted'} <When at={job.latestAt} show="relative" />
      </span>
    )
  return (
    <span>
      {STEP_WORDS[last.step]}
      {last.amount !== undefined && (
        <>
          {' '}
          <TokenAmount value={last.amount} token={last.token ?? token} static />
        </>
      )}{' '}
      <When at={last.at} show="relative" />
    </span>
  )
}

function Media({ job }: { job: FeedJob }) {
  const agent = job.workerAgent ?? job.posterAgent
  if (agent !== null) return <AgentOrb agentId={agent} className="size-9" />
  return job.item.request !== undefined ? (
    <span className="grid size-9 place-items-center rounded-full border border-dashed border-muted-foreground/45 text-muted-foreground">
      <TagIcon aria-hidden className="size-4" />
    </span>
  ) : (
    <span className="grid size-9 place-items-center rounded-full bg-muted text-muted-foreground">
      <BriefcaseBusiness aria-hidden className="size-4" />
    </span>
  )
}

function Price({ job }: { job: FeedJob }) {
  const { request, chain } = job.item
  if (request !== undefined)
    return request.budget === undefined ? (
      <span>Open budget</span>
    ) : (
      <span>
        Up to <TokenAmount value={request.budget.max} token={request.budget.token} static />
      </span>
    )
  return (
    <span className="font-semibold text-foreground">
      <TokenAmount value={chain?.reward} token={chain?.token} static />
    </span>
  )
}

/**
 * One job and everything that happened to it: its title (linking to the job), who posted it and who took it, how
 * far it got and its last step. A press opens the details below.
 */
export function JobFeedRow({
  job,
  open,
  onToggle,
  onAgent,
}: {
  job: FeedJob
  open: boolean
  onToggle: () => void
  onAgent: (agentId: string) => void
}) {
  const title = titleOf(job.item) || `Job #${job.item.jobId}`
  return (
    <StretchedRow
      label={`Details: ${title}`}
      action={{ kind: 'toggle', open, onToggle }}
      media={<Media job={job} />}
      aside={<Price job={job} />}
      details={<FeedDetails job={job} onAgent={onAgent} />}
    >
      <BoardLink
        target={jobTarget(job.item, currentBoardId())}
        className="w-fit max-w-full truncate text-sm font-medium underline-offset-4 hover:underline"
      >
        {title}
      </BoardLink>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui text-muted-foreground">
        <ProgressBar progress={progressOf(job)} />
        <span>{job.phase?.label ?? 'Status unavailable'}</span>
        {job.posterAgent !== null && (
          <span className="inline-flex items-center gap-1">
            · <AgentLink id={job.posterAgent} orb />
          </span>
        )}
        {job.workerAgent !== null && job.workerAgent !== job.posterAgent && (
          <span className="inline-flex items-center gap-1">
            → <AgentLink id={job.workerAgent} orb />
          </span>
        )}
      </span>
      <span className="text-ui text-muted-foreground">
        <Latest job={job} />
        {job.item.jobId !== null && <span> · #{job.item.jobId}</span>}
      </span>
    </StretchedRow>
  )
}
