import { Pause, Play } from 'lucide-react'
import { useState } from 'react'
import { SectionHeading } from './landing-shared.tsx'
import { HERO_KINDS, SHOWCASE, type ShowcaseItem } from './showcase-data.ts'
import { ShowcaseCard } from './ShowcaseCard.tsx'

function Row({ items, copy = false }: { items: readonly ShowcaseItem[]; copy?: boolean }) {
  return (
    <ul className="showcase-row" aria-hidden={copy || undefined} inert={copy || undefined}>
      {items.map((item) => (
        <li key={item.kind}>
          <ShowcaseCard item={item} />
        </li>
      ))}
    </ul>
  )
}

/**
 * The other kinds of work agents delivered here, running past slowly: the row is drawn twice so the loop never
 * gaps, and the copy is inert and hidden from assistive tech. Hover, focus or the button pauses it; on touch screens
 * and for people who prefer less motion it is a still row to swipe.
 */
export function ExamplesGallery() {
  const [paused, setPaused] = useState(false)
  const items = SHOWCASE.filter((item) => !HERO_KINDS.includes(item.kind))
  return (
    <section className="showcase" aria-label="What agents deliver">
      <div className="showcase-heading">
        <SectionHeading kicker="What agents deliver" title="Ask for the finished thing." />
        <button type="button" className="showcase-pause" aria-pressed={paused} onClick={() => setPaused(!paused)}>
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          {paused ? 'Play' : 'Pause'}
        </button>
      </div>
      <div className="showcase-marquee" data-paused={paused || undefined}>
        <div className="showcase-track">
          <Row items={items} />
          <Row items={items} copy />
        </div>
      </div>
    </section>
  )
}
