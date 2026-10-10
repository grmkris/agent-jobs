import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { chainJobs, currentBoardId } from '../../api.ts'
import { stage } from '../../wallet.ts'
import { type ShowcaseItem, showcaseJob } from './showcase-data.ts'
import { ICON_PACK, showcaseShot } from './showcase-images.ts'
import { PaperPreview } from './previews/docs.tsx'
import { IconsPreview } from './previews/icons.tsx'
import { ObjectPreview, PrintPreview } from './previews/objects.tsx'
import { PlayerPreview, PodcastPreview } from './previews/media.tsx'
import { BrowserPreview } from './previews/web.tsx'

/** The card's image in the frame its kind is drawn in. */
function Preview({ item, eager }: { item: ShowcaseItem; eager: boolean }) {
  const alt = `${item.label} delivered by ${item.agent.name}`
  const duration = item.duration ?? ''
  const shot = showcaseShot(item.delivered.jobId) ?? ''
  switch (item.kind) {
    case 'icons':
      return <IconsPreview icons={ICON_PACK} />
    case 'video':
    case 'documentary':
      return <PlayerPreview shot={shot} duration={duration} alt={alt} eager={eager} />
    case 'podcast':
      return <PodcastPreview cover={shot} duration={duration} alt={alt} eager={eager} />
    case 'site':
    case 'game':
    case 'dashboard':
      return <BrowserPreview shot={shot} url={item.delivered.url} alt={alt} eager={eager} />
    case 'part':
      return <ObjectPreview shot={shot} alt={alt} eager={eager} />
    case 'print':
      return <PrintPreview shot={shot} alt={alt} eager={eager} />
    case 'memo':
    case 'proposal':
      return <PaperPreview shot={shot} alt={alt} eager={eager} />
  }
}

function AgentLink({ agent, children }: { agent: { name: string; agentId: string }; children: ReactNode }) {
  return (
    <Link to="/agent/$agentId" params={{ agentId: agent.agentId }} className="showcase-agent">
      {children}
    </Link>
  )
}

/**
 * What the job paid its agent, in its token, from the chain list every board page reads (same query, one fetch).
 * Undefined until it loads, and on a stage where the card's job is not on the board.
 */
function usePaid(jobId: string | undefined) {
  const boardId = currentBoardId()
  return useQuery({
    queryKey: ['chain-jobs', boardId],
    queryFn: () => chainJobs(boardId),
    enabled: jobId !== undefined,
    staleTime: 60_000,
    select: (list) => list.jobs.find((job) => job.job_id === jobId),
  }).data
}

/**
 * One delivered job as a card: what was delivered, in its frame, the job's title, who posted it and who did it. On
 * the job's own stage the whole card opens the job; elsewhere it is an example and only its agent links.
 */
export function ShowcaseCard({
  item,
  eager = false,
  className,
  slot,
}: {
  item: ShowcaseItem
  eager?: boolean
  className?: string
  /** Where the hero's fan holds this card (front, middle, back). */
  slot?: string
}) {
  const job = showcaseJob(item, stage)
  const paid = usePaid(job?.jobId)
  return (
    <article
      className={className === undefined ? 'showcase-card' : `showcase-card ${className}`}
      data-kind={item.kind}
      data-slot={slot}
    >
      {job !== null && (
        <Link
          to="/job/$jobId"
          params={{ jobId: job.jobId }}
          className="showcase-open"
          aria-label={`Job #${job.jobId}: ${item.title}`}
        />
      )}
      <div className="showcase-frame">
        <Preview item={item} eager={eager} />
      </div>
      <div className="showcase-text">
        <p className="showcase-label">{item.label}</p>
        <p className="showcase-ask">“{item.title}”</p>
      </div>
      <footer className="showcase-footer">
        <span className="showcase-people">
          {job !== null && (
            <>
              <AgentLink agent={job.poster}>
                <AgentOrb agentId={job.poster.agentId} size="sm" />
                <span className="sr-only">Posted by {job.poster.name}</span>
              </AgentLink>
              <span aria-hidden="true">→</span>
            </>
          )}
          <AgentLink agent={item.agent}>
            <AgentOrb agentId={item.agent.agentId} size="sm" />
            {item.agent.name}
          </AgentLink>
        </span>
        {job !== null ? (
          <span className="showcase-status">
            {paid?.net != null ? (
              <>
                Paid <TokenAmount value={paid.net} token={paid.token} static />
              </>
            ) : (
              'Delivered'
            )}
            <span className="showcase-job"> · #{job.jobId}</span>
          </span>
        ) : (
          <span className="proof-example">Example</span>
        )}
      </footer>
    </article>
  )
}
