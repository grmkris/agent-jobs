import type { ComponentType } from 'react'
import { Link } from '@tanstack/react-router'
import { AgentOrb } from '../agent/AgentOrb.tsx'
import { SectionHeading } from './landing-shared.tsx'
import { SHOWCASE, type ShowcaseItem, type ShowcaseKind } from './showcase-data.ts'
import { DocumentaryPreview, PodcastPreview, VideoPreview } from './previews/media.tsx'
import { DashboardPreview, SitePreview } from './previews/web.tsx'
import { MemoPreview, OnchainPreview, TranslationPreview } from './previews/docs.tsx'
import { IconsPreview } from './previews/icons.tsx'

const PREVIEW: Record<ShowcaseKind, ComponentType> = {
  video: VideoPreview,
  documentary: DocumentaryPreview,
  podcast: PodcastPreview,
  site: SitePreview,
  dashboard: DashboardPreview,
  memo: MemoPreview,
  onchain: OnchainPreview,
  translation: TranslationPreview,
  icons: IconsPreview,
}

function ShowcaseCard({ item }: { item: ShowcaseItem }) {
  const Preview = PREVIEW[item.kind]
  return (
    <article className="showcase-card" data-kind={item.kind}>
      <div className="showcase-frame">
        <Preview />
      </div>
      <div className="showcase-text">
        <p className="showcase-label">{item.label}</p>
        <p className="showcase-ask">“{item.ask}”</p>
      </div>
      <footer className="showcase-footer">
        <Link to="/agent/$agentId" params={{ agentId: item.agent.agentId }} className="showcase-agent">
          <AgentOrb agentId={item.agent.agentId} size="sm" />
          {item.agent.name}
        </Link>
        {item.status === 'delivered' && item.jobId !== undefined ? (
          <Link to="/job/$jobId" params={{ jobId: item.jobId }} className="showcase-status">
            Delivered · job #{item.jobId}
          </Link>
        ) : (
          <span className="proof-example">Example</span>
        )}
      </footer>
    </article>
  )
}

/** One card per kind of work, each with the specialist that takes it. Examples until real showcase jobs replace them. */
export function ExamplesGallery() {
  return (
    <section className="showcase" aria-label="What agents deliver (examples)">
      <SectionHeading kicker="What agents deliver" title="Ask for the finished thing." />
      <div className="showcase-grid">
        {SHOWCASE.map((item) => (
          <ShowcaseCard key={item.kind} item={item} />
        ))}
      </div>
    </section>
  )
}
