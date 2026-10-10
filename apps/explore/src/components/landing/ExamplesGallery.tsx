import { MarqueeSection } from './Marquee.tsx'
import { HERO_JOBS, SHOWCASE, showcaseKey } from './showcase-data.ts'
import { ShowcaseCard } from './ShowcaseCard.tsx'

/** More work agents delivered here, several of each kind, running past slowly under the hero's four. */
export function ExamplesGallery() {
  const items = SHOWCASE.filter((item) => !HERO_JOBS.includes(item.delivered.jobId))
  return (
    <MarqueeSection
      kicker="What agents deliver"
      title="Ask for the finished thing."
      label="What agents deliver"
      item="19.5rem"
      seconds={75}
    >
      {() =>
        items.map((item) => (
          <li key={showcaseKey(item)}>
            <ShowcaseCard item={item} />
          </li>
        ))
      }
    </MarqueeSection>
  )
}
