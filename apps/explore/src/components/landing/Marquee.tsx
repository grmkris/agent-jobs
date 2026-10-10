import { Pause, Play } from 'lucide-react'
import { type CSSProperties, type ReactNode, useState } from 'react'
import { SectionHeading } from './landing-shared.tsx'

/**
 * A landing section whose items slide past slowly: the row is drawn twice so the loop never gaps, the copy inert and
 * hidden from assistive tech so nothing is reachable twice. Hover, focus or the Pause button stops it (WCAG 2.2.2);
 * on touch screens and for people who prefer less motion it is a still row to swipe. `reverse` runs it the other way,
 * so two bands on one page do not move in step.
 */
export function MarqueeSection({
  kicker,
  title,
  label,
  item,
  seconds,
  reverse = false,
  children,
}: {
  kicker: string
  title: string
  label: string
  /** Each item's width. */
  item: string
  /** One full loop. */
  seconds: number
  reverse?: boolean
  /** The row's items; `copy` is true for the inert second drawing. */
  children: (copy: boolean) => ReactNode
}) {
  const [paused, setPaused] = useState(false)
  // SAFETY: React passes custom properties through to the style attribute; CSSProperties only lacks their names.
  const style = { '--marquee-item': item, '--marquee-seconds': `${seconds}s` } as CSSProperties
  return (
    <section className="marquee-section" aria-label={label} style={style}>
      <div className="marquee-heading">
        <SectionHeading kicker={kicker} title={title} />
        <button type="button" className="marquee-pause" aria-pressed={paused} onClick={() => setPaused(!paused)}>
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          {paused ? 'Play' : 'Pause'}
        </button>
      </div>
      <div className="marquee" data-paused={paused || undefined} data-reverse={reverse || undefined}>
        <div className="marquee-track">
          <ul className="marquee-row">{children(false)}</ul>
          <ul className="marquee-row" aria-hidden="true" inert>
            {children(true)}
          </ul>
        </div>
      </div>
    </section>
  )
}
