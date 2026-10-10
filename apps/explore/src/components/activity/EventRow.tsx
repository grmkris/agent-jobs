import type { FeedEvent } from '../../activity-feed.ts'
import { activityIcon } from '../../activity.ts'
import { currentBoardId } from '../../api.ts'
import { jobTarget } from '../../job-list.ts'
import { type LiveItem, liveSentence } from '../../live-activity.ts'
import { ActivityIcon } from '../ActivityRow.tsx'
import { AgentLink } from '../agent/AgentChip.tsx'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { BoardLink, type LinkTarget, boardRoutes } from '../BoardLink.tsx'
import { When } from '../Time.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { FeedDetails } from './FeedDetails.tsx'
import { StretchedRow } from './StretchedRow.tsx'

/** The feed kind whose icon a row borrows when no agent is named. */
const ICON_KIND: Readonly<Record<LiveItem['kind'], string>> = {
  requested: 'request.opened',
  posted: 'job.published',
  hired: 'job.activated',
  delivered: 'job.submitted',
  completed: 'job.completed',
  rejected: 'job.rejected',
  disputed: 'job.disputed',
  ruled: 'job.ruled',
  cancelled: 'job.cancelled',
  expired: 'job.expired',
}

/** Where the event's work opens: its job or request on the board that holds it. */
function eventTarget(event: FeedEvent): LinkTarget {
  if (event.job !== undefined) return jobTarget(event.job.item, currentBoardId())
  const routes = boardRoutes()
  return event.jobId === null ? routes.request(event.requestId ?? '') : routes.job(event.jobId)
}

/** The sentence around the quoted title, so the title can be its own link. */
function aroundTitle(text: string, title: string): [string, string] {
  const quoted = `“${title}”`
  const at = text.indexOf(quoted)
  return at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + quoted.length)]
}

/**
 * One thing that happened, as a sentence: who did it (linking to the agent), what, to which job (linking to the
 * job), for how much and when. On Activity a press opens the job's details below; on the landing it opens the job.
 */
export function EventRow({
  event,
  open,
  onToggle,
  onAgent,
  linkOnly = false,
}: {
  event: FeedEvent
  open: boolean
  onToggle: () => void
  onAgent: (agentId: string) => void
  /** The landing's compact feed: the row is a link to the job, with no details. */
  linkOnly?: boolean
}) {
  const { agent, text } = liveSentence(event)
  const [before, after] = aroundTitle(text, event.title)
  const target = eventTarget(event)
  // The landing's rows only link; Activity's open the job's details, when the page has the job's record.
  const job = linkOnly ? undefined : event.job
  return (
    <StretchedRow
      label={`${agent && event.agentId !== null ? `Agent ${event.agentId} ` : ''}${text}`}
      action={job !== undefined ? { kind: 'toggle', open, onToggle } : { kind: 'link', target }}
      media={
        event.agentId === null ? (
          <ActivityIcon icon={activityIcon(ICON_KIND[event.kind])} />
        ) : (
          <AgentOrb agentId={event.agentId} className="size-9" />
        )
      }
      aside={<When at={event.at} show="relative" />}
      details={job !== undefined ? <FeedDetails job={job} onAgent={onAgent} /> : undefined}
    >
      <p className="text-sm leading-snug">
        {agent && event.agentId !== null && (
          <>
            <AgentLink id={event.agentId} />{' '}
          </>
        )}
        {before}
        <BoardLink target={target} className="font-medium underline-offset-4 hover:underline">
          “{event.title}”
        </BoardLink>
        {after}
        {event.amount !== undefined && (
          <span className="text-muted-foreground">
            {' '}
            · <TokenAmount value={event.amount} token={event.token} static />
          </span>
        )}
      </p>
    </StretchedRow>
  )
}
