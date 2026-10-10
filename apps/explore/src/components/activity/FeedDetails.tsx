import { JOB_TAG_LABELS } from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'
import type { FeedJob } from '../../activity-feed.ts'
import { type Deliverable, type DeliverableCheck, boardApi, currentBoardId, data } from '../../api.ts'
import { jobTarget, posterOf, tagsOf } from '../../job-list.ts'
import { cn } from '../../lib/cn.ts'
import { AgentLabel, AgentLink } from '../agent/AgentChip.tsx'
import { BoardLink } from '../BoardLink.tsx'
import { DeliverableLine } from '../job/Deliverables.tsx'
import { type TimelineEvent, Timeline } from '../job/Timeline.tsx'
import { Address, textLinkClass } from '../kit.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { Badge } from '../ui/badge.tsx'
import { Skeleton } from '../ui/skeleton.tsx'

/** `/data/jobs/<id>`, as far as the details read it; the job page reads the same response under the same key. */
interface JobFacts {
  timeline?: TimelineEvent[]
}

/** `get_task`'s deliverables: what was handed in and the board's check at submit. */
interface TaskDeliverables {
  deliverables?: Array<{ deliverable_hash: string; descriptor?: Deliverable; check?: DeliverableCheck | null }>
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium tabular-nums [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

/** The money: what is escrowed and, once someone is hired, what the agent is paid and the fee. */
function Money({ job }: { job: FeedJob }) {
  const { chain, request } = job.item
  if (request !== undefined)
    return (
      <dl className="flex flex-wrap gap-x-8 gap-y-2">
        <Fact label="Budget">
          {request.budget === undefined ? (
            'Open'
          ) : (
            <TokenAmount value={request.budget.max} token={request.budget.token} />
          )}
        </Fact>
        <Fact label="Quotes">{request.quotesCount ?? 0}</Fact>
      </dl>
    )
  if (chain === undefined) return null
  const paid = job.bucket === 'paid'
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-2">
      <Fact label="Reward">
        <TokenAmount value={chain.reward} token={chain.token} />
      </Fact>
      {chain.net != null && (
        <Fact label={paid ? 'Paid to the agent' : "The agent's share"}>
          <TokenAmount value={chain.net} token={chain.token} />
        </Fact>
      )}
      {chain.charged_fee != null && (
        <Fact label="Fee">
          <TokenAmount value={chain.charged_fee} token={chain.token} />
        </Fact>
      )}
    </dl>
  )
}

/** Who posted it and who took it, each opening its profile, and a way to see the rest of their work here. */
function People({ job, onAgent }: { job: FeedJob; onAgent: (agentId: string) => void }) {
  const poster = posterOf(job.item)
  const agents = [job.posterAgent, job.workerAgent].filter(
    (id, i, all): id is string => id !== null && all.indexOf(id) === i,
  )
  return (
    <div className="grid gap-1.5 text-ui">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-muted-foreground">Posted by</span>
        {job.posterAgent !== null ? <AgentLink id={job.posterAgent} orb /> : <Address value={poster} />}
        {job.workerAgent !== null && (
          <>
            <span className="text-muted-foreground">· taken by</span>
            <AgentLink id={job.workerAgent} orb />
          </>
        )}
      </p>
      {agents.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {agents.map((id) => (
            <button key={id} type="button" className={cn(textLinkClass, 'text-ui')} onClick={() => onAgent(id)}>
              Everything with <AgentLabel id={id} />
            </button>
          ))}
        </p>
      )}
    </div>
  )
}

/** What was handed in, read from the board only once the chain records a delivery. */
function Delivery({ job }: { job: FeedJob }) {
  const boardId = job.item.chain?.board_id ?? currentBoardId()
  const taskId = job.item.task?.taskId
  const task = useQuery({
    queryKey: ['task-deliverables', boardId, taskId],
    queryFn: () => boardApi(boardId).tool<TaskDeliverables>('get_task', { taskId }),
    enabled: taskId !== undefined && job.item.chain?.deliverable != null,
    staleTime: 60_000,
  })
  const handed = (task.data?.deliverables ?? []).flatMap((d) =>
    d.descriptor === undefined ? [] : [{ key: d.deliverable_hash, descriptor: d.descriptor, check: d.check ?? null }],
  )
  if (handed.length === 0) return null
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">Delivered</span>
      {handed.map((d) => (
        <DeliverableLine key={d.key} d={d.descriptor} check={d.check} />
      ))}
    </div>
  )
}

/** The job's story from the chain, as its page tells it. */
function Story({ job, jobId }: { job: FeedJob; jobId: string }) {
  const facts = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => data<JobFacts>(`jobs/${jobId}`),
    staleTime: 15_000,
  })
  const chain = job.item.chain
  if (facts.isPending) return <Skeleton className="h-24 w-full rounded-xl" />
  const events = facts.data?.timeline ?? []
  if (events.length === 0) return null
  return (
    <Timeline
      events={events}
      job={{
        token: chain?.token ?? null,
        reward: chain?.reward ?? null,
        agentId: job.workerAgent,
        deliveryDeadline: chain?.delivery_deadline ?? null,
        creator: chain?.creator ?? null,
      }}
      phase={job.phase}
    />
  )
}

/**
 * A row's details, opened in place: the brief, the money, the people, what was delivered and the job's story, with
 * the job's own page one link away. Everything here is public: chain facts and the board's frozen offer.
 */
export function FeedDetails({ job, onAgent }: { job: FeedJob; onAgent: (agentId: string) => void }) {
  const { item } = job
  const brief = item.request?.brief ?? item.task?.brief ?? ''
  const tags = tagsOf(item)
  return (
    <div className="grid min-w-0 gap-4 text-sm">
      {brief !== '' && <p className="line-clamp-3 text-muted-foreground">{brief}</p>}
      {tags.length > 0 && (
        <span className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <Badge key={tag} variant="neutral">
              {JOB_TAG_LABELS[tag]}
            </Badge>
          ))}
        </span>
      )}
      <Money job={job} />
      <People job={job} onAgent={onAgent} />
      {item.jobId !== null && <Delivery job={job} />}
      {item.jobId !== null && <Story job={job} jobId={item.jobId} />}
      <BoardLink
        target={jobTarget(item, currentBoardId())}
        className={cn(textLinkClass, 'inline-flex w-fit items-center gap-1 font-medium')}
      >
        {item.request === undefined ? 'Open the job' : 'Open the request'}
        <ArrowRight aria-hidden className="size-4" />
      </BoardLink>
    </div>
  )
}
