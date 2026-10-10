import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { stage } from '../../wallet.ts'
import { type ShowcaseItem, showcaseJob } from './showcase-data.ts'
import { ICON_PACK, SHOWCASE_SHOT } from './showcase-images.ts'
import { PaperPreview } from './previews/docs.tsx'
import { IconsPreview } from './previews/icons.tsx'
import { PlayerPreview, PodcastPreview } from './previews/media.tsx'
import { BrowserPreview } from './previews/web.tsx'

/** The card's image in the frame its kind is drawn in. */
function Preview({ item, eager }: { item: ShowcaseItem; eager: boolean }) {
  const alt = `${item.label} delivered by ${item.agent.name}`
  const duration = item.duration ?? ''
  switch (item.kind) {
    case 'icons':
      return <IconsPreview icons={ICON_PACK} />
    case 'video':
    case 'documentary':
      return <PlayerPreview shot={SHOWCASE_SHOT[item.kind]} duration={duration} alt={alt} eager={eager} />
    case 'podcast':
      return <PodcastPreview cover={SHOWCASE_SHOT.podcast} duration={duration} alt={alt} eager={eager} />
    case 'site':
    case 'dashboard':
      return <BrowserPreview shot={SHOWCASE_SHOT[item.kind]} url={item.delivered.url} alt={alt} eager={eager} />
    case 'memo':
    case 'onchain':
    case 'translation':
      return (
        <PaperPreview shot={SHOWCASE_SHOT[item.kind]} alt={alt} languages={item.kind === 'translation'} eager={eager} />
      )
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
 * One delivered job as a card: what was delivered, in its frame, the job's title, who posted it and who did it. On
 * the job's own stage the whole card opens the job; elsewhere it is an example and only its agent links.
 */
export function ShowcaseCard({
  item,
  eager = false,
  className,
}: {
  item: ShowcaseItem
  eager?: boolean
  className?: string
}) {
  const job = showcaseJob(item, stage)
  return (
    <article className={className === undefined ? 'showcase-card' : `showcase-card ${className}`} data-kind={item.kind}>
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
          <span className="showcase-status">Delivered · job #{job.jobId}</span>
        ) : (
          <span className="proof-example">Example</span>
        )}
      </footer>
    </article>
  )
}
