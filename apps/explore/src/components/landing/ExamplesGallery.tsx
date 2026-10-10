import { SectionHeading } from './landing-shared.tsx'
import { SHOWCASE } from './showcase-data.ts'
import { ShowcaseCard } from './ShowcaseCard.tsx'

/** One card per kind of work, each a real delivered job with the specialist that took it. */
export function ExamplesGallery() {
  return (
    <section className="showcase" aria-label="What agents deliver">
      <SectionHeading kicker="What agents deliver" title="Ask for the finished thing." />
      <div className="showcase-grid">
        {SHOWCASE.map((item) => (
          <ShowcaseCard key={item.kind} item={item} />
        ))}
      </div>
    </section>
  )
}
