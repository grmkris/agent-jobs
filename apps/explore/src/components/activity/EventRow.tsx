import type { FeedEvent } from '../../activity-feed.ts'
import { activityIcon } from '../../activity.ts'
import { currentBoardId } from '../../api.ts'
import { jobTarget } from '../../job-list.ts'
import { type LiveItem, liveSentence } from '../../live-activity.ts'
import { ActivityIcon } from '../ActivityRow.tsx'
import { AgentPeekLink, AgentPeekOrb } from '../agent/AgentPeek.tsx'
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

/** Who did it: the agent's orb (with its card), and the paying agent's small orb on its corner when a paid step names both. */
function EventMedia({ event, payer }: { event: FeedEvent; payer: string | undefined }) {
  if (event.agentId === null) return <ActivityIcon icon={activityIcon(ICON_KIND[event.kind])} />
  return (
    <span className="relative inline-flex">
      <AgentPeekOrb id={event.agentId} className="size-9" />
      {payer !== undefined && (
        <span className="absolute -right-1.5 -bottom-1.5 inline-flex rounded-full ring-2 ring-card">
          <AgentPeekOrb id={payer} className="size-5" />
        </span>
      )}
    </span>
  )
}

/**
 * One thing that happened, as a sentence: who did it (linking to the agent), what, to which job (linking to the
 * job), for how much and when. A paid step whose poster is known reads "<payer> paid <agent> <amount> for “…”". On
 * Activity a press opens the job's details below; on the landing it opens the job.
 */
export function EventRow({
  event,
  details,
}: {
  event: FeedEvent
  /** Activity's rows open the job's details in place; without this (the landing) the row links to the job. */
  details?: { open: boolean; onToggle: () => void; onAgent: (agentId: string) => void }
}) {
  const { agent, text, payer } = liveSentence(event, event.job?.posterAgent ?? null)
  const [before, after] = aroundTitle(text, event.title)
  const target = eventTarget(event)
  // Details need the job's record; an event on a job this page cannot read only links.
  const job = details === undefined ? undefined : event.job
  const amount = event.amount === undefined ? null : <TokenAmount value={event.amount} token={event.token} static />
  const who = agent && event.agentId !== null ? `Agent ${event.agentId} ` : ''
  return (
    <StretchedRow
      label={payer === undefined ? `${who}${text}` : `Agent ${payer} paid ${who}${text}`}
      action={
        job !== undefined && details !== undefined
          ? { kind: 'toggle', open: details.open, onToggle: details.onToggle }
          : { kind: 'link', target }
      }
      media={<EventMedia event={event} payer={payer} />}
      aside={<When at={event.at} show="relative" />}
      details={
        job !== undefined && details !== undefined ? <FeedDetails job={job} onAgent={details.onAgent} /> : undefined
      }
    >
      <p className="text-sm leading-snug">
        {payer !== undefined && (
          <>
            <AgentPeekLink id={payer} /> paid{' '}
          </>
        )}
        {agent && event.agentId !== null && (
          <>
            <AgentPeekLink id={event.agentId} />{' '}
          </>
        )}
        {payer !== undefined && amount !== null && <>{amount} </>}
        {before}
        <BoardLink target={target} className="font-medium underline-offset-4 hover:underline">
          “{event.title}”
        </BoardLink>
        {after}
        {payer === undefined && amount !== null && <span className="text-muted-foreground"> · {amount}</span>}
      </p>
    </StretchedRow>
  )
}
