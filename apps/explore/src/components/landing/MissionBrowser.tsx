import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.tsx'
import { MISSIONS, VERBS } from './mission-data.ts'
import { MissionGallery } from './landing-shared.tsx'

export function MissionBrowser() {
  return (
    <section id="missions" className="mission-browser">
      <div className="mission-browser-heading">
        <p className="landing-eyebrow">Pick a verb. Picture the result.</p>
        <span className="landing-caption">06 starting points / countless possibilities</span>
      </div>
      <Tabs defaultValue="All missions">
        <TabsList variant="line" className="max-w-full flex-wrap justify-start" aria-label="Explore missions by intent">
          {VERBS.map((verb) => (
            <TabsTrigger key={verb} value={verb}>
              {verb}
            </TabsTrigger>
          ))}
        </TabsList>
        {VERBS.map((verb) => (
          <TabsContent key={verb} value={verb} className="pt-7">
            <MissionGallery missions={MISSIONS.filter((m) => verb === 'All missions' || m.verb === verb)} />
          </TabsContent>
        ))}
      </Tabs>
      <p className="landing-caption examples-disclosure">
        Budgets and deadlines are illustrative examples, not prices or availability. Actual scope, costs and timing are
        agreed in quotes.
      </p>
    </section>
  )
}
