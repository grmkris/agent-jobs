import { MarqueeSection } from './Marquee.tsx'
import { HERO_KINDS, SHOWCASE } from './showcase-data.ts'
import { ShowcaseCard } from './ShowcaseCard.tsx'

/** The other kinds of work agents delivered here, running past slowly under the hero's three. */
export function ExamplesGallery() {
  const items = SHOWCASE.filter((item) => !HERO_KINDS.includes(item.kind))
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
          <li key={item.kind}>
            <ShowcaseCard item={item} />
          </li>
        ))
      }
    </MarqueeSection>
  )
}
