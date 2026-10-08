import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.tsx'
import { MissionArt } from './MissionArt.tsx'
import { MISSIONS, VERBS } from './mission-data.ts'
import { MissionGallery, WorkflowStrip } from './landing-shared.tsx'

export function FieldGuide() {
  return (
    <>
      <section className="field-guide-hero">
        <div className="field-guide-title">
          <p className="landing-eyebrow">A field guide to getting things done</p>
          <h1>
            Get it off
            <br />
            your list.
          </h1>
          <p className="landing-description hero-description">
            That fix. That deep dive. That world you want to build. There’s a brief in every unfinished idea.
          </p>
          <a href="#missions" className="field-guide-link">
            Find your next mission <span aria-hidden="true">↘</span>
          </a>
        </div>
        <div className="field-guide-collage" aria-label="Illustrations of possible deliverables">
          <figure className="collage-research">
            <MissionArt kind="research" />
            <figcaption>A question, investigated.</figcaption>
          </figure>
          <figure className="collage-assets">
            <MissionArt kind="assets" />
            <figcaption>A world, ready to build.</figcaption>
          </figure>
          <div className="collage-miniatures">
            <figure>
              <MissionArt kind="code" />
              <figcaption>A fix.</figcaption>
            </figure>
            <figure>
              <MissionArt kind="travel" />
              <figcaption>A route.</figcaption>
            </figure>
            <figure>
              <MissionArt kind="audit" />
              <figcaption>A finding.</figcaption>
            </figure>
          </div>
          <span className="collage-note">
            The useful part?
            <br />
            You get an artifact.
          </span>
        </div>
      </section>
      <section id="missions" className="field-guide-missions">
        <div className="field-guide-section-title">
          <p className="landing-eyebrow">Pick a verb. Picture the result.</p>
          <span className="landing-caption">06 starting points / countless possibilities</span>
        </div>
        <Tabs defaultValue="All missions">
          <TabsList
            variant="line"
            className="max-w-full flex-wrap justify-start"
            aria-label="Explore missions by intent"
          >
            {VERBS.map((verb) => (
              <TabsTrigger key={verb} value={verb}>
                {verb}
              </TabsTrigger>
            ))}
          </TabsList>
          {VERBS.map((verb) => (
            <TabsContent key={verb} value={verb} className="pt-7">
              <MissionGallery missions={MISSIONS.filter((m) => verb === 'All missions' || m.verb === verb)} examples />
            </TabsContent>
          ))}
        </Tabs>
        <p className="landing-caption examples-disclosure">
          Budgets and deadlines are illustrative examples, not prices or availability. Actual scope, costs and timing
          are agreed in quotes.
        </p>
      </section>
      <WorkflowStrip />
    </>
  )
}
