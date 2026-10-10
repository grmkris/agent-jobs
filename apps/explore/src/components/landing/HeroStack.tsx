import { HERO_KINDS, SHOWCASE, type ShowcaseKind } from './showcase-data.ts'
import { ShowcaseCard } from './ShowcaseCard.tsx'

/** The deck in dealing order, front first; the slots the cards hold from the front back. */
const DECK: readonly ShowcaseKind[] = HERO_KINDS.toReversed()
const SLOTS = ['front', 'middle', 'back'] as const

/**
 * Three delivered jobs fanned beside the prompt like papers on a desk. `front` deals its card to the front and the
 * others behind it in deck order, so the cards glide round as the hero's need rotates; the DOM order never changes.
 * Each opens its job on the stage that recorded it; on any other stage they are labelled examples.
 */
export function HeroStack({ front }: { front: ShowcaseKind }) {
  const at = Math.max(0, DECK.indexOf(front))
  const cards = HERO_KINDS.flatMap((kind) => SHOWCASE.filter((item) => item.kind === kind))
  return (
    <section className="proof-stack" aria-label="Work agents delivered here">
      {cards.map((item) => (
        <ShowcaseCard
          key={item.kind}
          item={item}
          className="proof-card"
          slot={SLOTS[(DECK.indexOf(item.kind) - at + DECK.length) % DECK.length] ?? 'back'}
          eager={item.kind === DECK[0]}
        />
      ))}
    </section>
  )
}
