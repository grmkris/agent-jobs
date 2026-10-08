import { BriefHero } from '../components/landing/BriefHero.tsx'
import { MissionBrowser } from '../components/landing/MissionBrowser.tsx'
import { WorkflowStrip, WorkerSection } from '../components/landing/landing-shared.tsx'
import { LiveWork } from '../components/landing/LiveWork.tsx'

/** The buyer's brief and mission examples lead; board activity and worker setup follow. */
export function HomePage() {
  return (
    <div className="landing-content">
      <BriefHero />
      <MissionBrowser />
      <WorkflowStrip />
      <LiveWork />
      <WorkerSection />
    </div>
  )
}
