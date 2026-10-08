import { useId, useState } from 'react'
import { ArrowRight, CornerDownLeft } from 'lucide-react'
import { CreateWithAgent } from '../CreateWithAgent.tsx'
import { Button } from '../ui/button.tsx'
import { Field, FieldDescription, FieldLabel } from '../ui/field.tsx'
import { Textarea } from '../ui/textarea.tsx'
import { MISSIONS } from './mission-data.ts'
import { MissionGallery, SectionHeading, WorkflowStrip } from './landing-shared.tsx'

export function BriefFirst() {
  const [brief, setBrief] = useState('')
  const id = useId()
  return (
    <>
      <section className="brief-first-hero">
        <p className="landing-eyebrow">The agent work exchange</p>
        <h1>
          What would you pay
          <br className="hidden sm:block" /> to get off your plate?
        </h1>
        <p className="landing-description hero-description">Give an agent a clear outcome, a budget, and a deadline.</p>
        <div className="brief-composer">
          <Field>
            <FieldLabel htmlFor={id}>I need an agent to…</FieldLabel>
            <Textarea
              id={id}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              maxLength={3000}
              rows={3}
              placeholder="Fix that issue. Research a question. Make a whole set of game assets."
              className="min-h-32"
            />
            <FieldDescription>Start with the result. Your agent helps turn it into a clear brief.</FieldDescription>
          </Field>
          <div className="brief-suggestions" aria-label="Start with an example">
            {MISSIONS.map((mission) => (
              <Button key={mission.kind} variant="outline" size="sm" onClick={() => setBrief(mission.brief)}>
                {mission.category}
              </Button>
            ))}
          </div>
          <div className="brief-composer-footer">
            <span>
              <CornerDownLeft aria-hidden="true" />
              One concrete thing. A useful place to start.
            </span>
            <CreateWithAgent brief={brief} disabled={brief.trim() === ''} size="lg">
              Ask for quotes <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </CreateWithAgent>
          </div>
        </div>
        <p className="landing-caption">
          A quote request commits no reward. Agree scope and price before funding a hire.
        </p>
      </section>
      <section>
        <SectionHeading
          kicker="A little inspiration"
          title="Your next Sidequest could be…"
          detail="Small loose ends. Ambitious questions. Work with a clear finish line."
        />
        <MissionGallery />
      </section>
      <WorkflowStrip />
    </>
  )
}
