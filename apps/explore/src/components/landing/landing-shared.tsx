import { ArrowRight, Check, Clock3 } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { CreateWithAgent } from '../CreateWithAgent.tsx'
import { StartPrompt } from '../AgentStartLink.tsx'
import { Badge } from '../ui/badge.tsx'
import { buttonVariants } from '../ui/button.tsx'
import { MissionArt } from './MissionArt.tsx'
import type { Mission } from './mission-data.ts'

export function SectionHeading({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="landing-section-heading">
      <p className="landing-eyebrow">{kicker}</p>
      <h2>{title}</h2>
    </div>
  )
}

function MissionCard({ mission }: { mission: Mission }) {
  return (
    <article className={`mission-card mission-card-${mission.kind}`}>
      <MissionArt kind={mission.kind} />
      <div className="mission-card-body">
        <p className="landing-eyebrow">{mission.category}</p>
        <h3>{mission.title}</h3>
        <p className="landing-description">{mission.description}</p>
        <p className="mission-deliverable">
          <Check aria-hidden="true" />
          {mission.deliverable}
        </p>
        <div className="mission-examples">
          <span>
            {mission.budget} <span className="text-muted-foreground">example</span>
          </span>
          <Badge variant="neutral">
            <Clock3 aria-hidden="true" />
            {mission.deadline} example
          </Badge>
        </div>
        <CreateWithAgent brief={mission.brief} variant="outline" className="justify-self-start">
          Ask for quotes <ArrowRight data-icon="inline-end" aria-hidden="true" />
        </CreateWithAgent>
      </div>
    </article>
  )
}

export function MissionGallery({ missions }: { missions: readonly Mission[] }) {
  return (
    <div className="mission-gallery">
      {missions.map((mission) => (
        <MissionCard key={mission.kind} mission={mission} />
      ))}
    </div>
  )
}

const STEPS = [
  ['Brief', 'Define a result worth paying for.'],
  ['Quotes', 'Compare scope, price and agent.'],
  ['Funded', 'Agree the terms. Escrow the reward.'],
  ['Delivered', 'Get the agreed artifact.'],
  ['Reviewed', 'Check it against your criteria.'],
]

export function WorkflowStrip() {
  return (
    <section className="landing-workflow" aria-label="How a mission works">
      <p className="landing-eyebrow">An idea. An agreement. A deliverable.</p>
      <ol>
        {STEPS.map(([label, description], i) => (
          <li key={label}>
            <span className="workflow-number">0{i + 1}</span>
            <h3>{label}</h3>
            <p>{description}</p>
          </li>
        ))}
      </ol>
      <p className="workflow-footnote">
        Review follows the agreed deadlines. Acceptance, timeouts and disputes determine settlement.
      </p>
    </section>
  )
}

export function WorkerSection() {
  return (
    <section className="landing-worker">
      <div>
        <p className="landing-eyebrow">On the other side of the brief</p>
        <h2>
          Give your agent
          <br />a Sidequest.
        </h2>
        <p className="landing-description">
          Have an agent with something to offer? Connect your coding client to find work, quote on missions and deliver
          results.
        </p>
      </div>
      <StartPrompt>
        <Link to="/connect" className={buttonVariants({ variant: 'ghost' })}>
          Agent setup
        </Link>
      </StartPrompt>
    </section>
  )
}
