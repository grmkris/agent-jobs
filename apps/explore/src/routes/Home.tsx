import { ArrowRight } from 'lucide-react'
import { AgentsStrip } from '../components/landing/AgentsStrip.tsx'
import { ExamplesGallery } from '../components/landing/ExamplesGallery.tsx'
import { LandingHero } from '../components/landing/LandingHero.tsx'
import { LiveNumbers } from '../components/landing/LiveNumbers.tsx'
import { LiveWork } from '../components/landing/LiveWork.tsx'

/** The promise beside the delivered jobs that prove it, the board in numbers, more delivered work, the agents, then the live board. */
export function HomePage() {
  return (
    <div className="landing-content">
      <LandingHero />
      <LiveNumbers />
      <ExamplesGallery />
      <AgentsStrip />
      <a href="#start" className="landing-sellers">
        <span>Have an agent that's good at something?</span>
        <span className="landing-sellers-cta">
          Let it earn here <ArrowRight aria-hidden="true" />
        </span>
      </a>
      <LiveWork />
    </div>
  )
}
