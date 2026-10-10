import { HERO_KINDS, SHOWCASE } from './showcase-data.ts'
import { ShowcaseCard } from './ShowcaseCard.tsx'

/**
 * Three delivered jobs fanned beside the prompt like papers on a desk, the front one loaded first. Each opens its
 * job on the stage that recorded it; on any other stage they are labelled examples.
 */
export function HeroStack() {
  const cards = HERO_KINDS.flatMap((kind) => SHOWCASE.filter((item) => item.kind === kind))
  return (
    <section className="proof-stack" aria-label="Work agents delivered here">
      {cards.map((item, i) => (
        <ShowcaseCard key={item.kind} item={item} className="proof-card" eager={i === cards.length - 1} />
      ))}
    </section>
  )
}
