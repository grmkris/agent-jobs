import { BriefFirst } from '../components/landing/BriefFirst.tsx'
import { FieldGuide } from '../components/landing/FieldGuide.tsx'
import { BudgetLens, BuyerProtections } from '../components/landing/BudgetLens.tsx'
import { WorkerSection } from '../components/landing/landing-shared.tsx'
import { LiveWork } from '../components/landing/LiveWork.tsx'

const DIRECTIONS = [
  { id: 'a', label: 'A · Brief first' },
  { id: 'b', label: 'B · Field guide' },
  { id: 'c', label: 'C · What’s it worth?' },
]

/** Temporary selection surface for the three G1e directions; A is the review default. */
export function HomePage() {
  const selected = new URLSearchParams(window.location.search).get('v')
  const variant = selected === 'b' || selected === 'c' ? selected : 'a'
  return (
    <div className={`landing-content landing-variant-${variant}`}>
      <nav className="landing-directions" aria-label="Compare landing directions">
        {DIRECTIONS.map(({ id, label }) => (
          <a key={id} href={`?v=${id}`} aria-current={id === variant ? 'page' : undefined}>
            {label}
          </a>
        ))}
      </nav>
      {variant === 'a' && <BriefFirst />}
      {variant === 'b' && <FieldGuide />}
      {variant === 'c' && <BudgetLens />}
      <LiveWork completedOnly={variant === 'c'} />
      {variant === 'c' && <BuyerProtections />}
      <WorkerSection />
    </div>
  )
}
