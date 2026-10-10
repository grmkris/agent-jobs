import { HERO_JOBS, SHOWCASE, showcaseKey } from './showcase-data.ts'
import { ShowcaseCard } from './ShowcaseCard.tsx'

/** The deck in dealing order, front first; the slots the cards hold from the front back, the last one out of sight. */
const SLOTS = ['front', 'middle', 'back', 'waiting'] as const

/**
 * Four delivered jobs on a desk beside the prompt, three of them fanned and the fourth waiting behind. `front` deals
 * its card to the front and the others behind it in rotation order, so the cards glide round as the hero's need
 * changes; the DOM order never does. Each opens its job on the stage that recorded it; on any other stage they are
 * labelled examples.
 */
export function HeroStack({ front }: { front: string }) {
  const at = Math.max(0, HERO_JOBS.indexOf(front))
  const cards = HERO_JOBS.flatMap((jobId) => SHOWCASE.filter((item) => item.delivered.jobId === jobId))
  return (
    <section className="proof-stack" aria-label="Work agents delivered here">
      {cards.map((item, i) => (
        <ShowcaseCard
          key={showcaseKey(item)}
          item={item}
          className="proof-card"
          slot={SLOTS[(i - at + HERO_JOBS.length) % HERO_JOBS.length] ?? 'waiting'}
          eager={i === 0}
        />
      ))}
    </section>
  )
}
