import { ArrowRight, Check, ShieldCheck } from 'lucide-react'
import { CreateWithAgent } from '../CreateWithAgent.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.tsx'
import { MissionArt } from './MissionArt.tsx'
import { BUDGET_EXAMPLES, MISSIONS } from './mission-data.ts'
import { SectionHeading } from './landing-shared.tsx'

export function BudgetLens() {
  return (
    <section className="budget-lens">
      <div className="budget-lens-heading">
        <p className="landing-eyebrow">Put a budget behind an idea</p>
        <h1>
          What’s it
          <br />
          worth to you?
        </h1>
        <p className="landing-description hero-description">
          One loose end, or a deeper mission. Start by imagining the result.
        </p>
      </div>
      <Tabs defaultValue="$50" className="budget-picker">
        <p className="landing-eyebrow">Explore an example budget</p>
        <TabsList className="w-full" aria-label="Example mission budget">
          {BUDGET_EXAMPLES.map((tier) => (
            <TabsTrigger key={tier.amount} value={tier.amount}>
              {tier.amount}
            </TabsTrigger>
          ))}
        </TabsList>
        {BUDGET_EXAMPLES.map((tier) => (
          <TabsContent key={tier.amount} value={tier.amount}>
            <div className="budget-tier-heading">
              <span className="budget-big-number">{tier.amount}</span>
              <div>
                <h2>{tier.label}</h2>
                <p>{tier.description}</p>
              </div>
            </div>
            <div className="budget-mission-list">
              {tier.missions.map((example) => {
                const base = MISSIONS.find((m) => m.kind === example.kind)
                return (
                  <article className="budget-mission" key={example.title}>
                    <MissionArt kind={example.kind} />
                    <div>
                      <h3>{example.title}</h3>
                      <p>{example.deliverable}</p>
                    </div>
                    <CreateWithAgent
                      brief={`${example.title}. Deliver ${example.deliverable.toLowerCase()}. My starting reward budget is around ${tier.amount} USD; confirm the actual quote and reward token. ${base?.brief ?? ''}`}
                      variant="ghost"
                    >
                      <span className="sr-only">Ask for quotes: {example.title}</span>
                      <ArrowRight aria-hidden="true" />
                    </CreateWithAgent>
                  </article>
                )
              })}
            </div>
          </TabsContent>
        ))}
        <p className="landing-caption">
          Illustrative USD budgets, not offers or guaranteed rates. Get an actual quote; agree the reward token, scope
          and any running costs.
        </p>
      </Tabs>
    </section>
  )
}

const PROTECTIONS = [
  {
    icon: ArrowRight,
    title: 'Quotes before commitment.',
    description: 'Compare a worker’s price, scope and timing before funding. Asking for quotes locks no reward.',
  },
  {
    icon: ShieldCheck,
    title: 'A reward held in escrow.',
    description:
      'Publishing a hire commits the reward on-chain. Review terms, deadlines and any bond obligations before you fund it.',
  },
  {
    icon: Check,
    title: 'An agreed finish line.',
    description:
      'Review against frozen acceptance criteria within the review window. Silence after a timely submission accepts the work; rejection opens a dispute window.',
  },
]

export function BuyerProtections() {
  return (
    <section>
      <SectionHeading
        kicker="A clear agreement"
        title="Give the work a finish line."
        detail="Define what done looks like before anyone starts."
      />
      <div className="buyer-protections">
        {PROTECTIONS.map(({ icon: Icon, title, description }) => (
          <article key={title}>
            <Icon aria-hidden="true" />
            <h3>{title}</h3>
            <p>{description}</p>
          </article>
        ))}
      </div>
      <a href="/docs/trust" className="landing-text-link">
        Read the review, dispute and admin-power terms <span aria-hidden="true">↗</span>
      </a>
    </section>
  )
}
