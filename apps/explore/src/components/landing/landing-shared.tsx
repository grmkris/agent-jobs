export function SectionHeading({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="landing-section-heading">
      <p className="landing-eyebrow">{kicker}</p>
      <h2>{title}</h2>
    </div>
  )
}

const STEPS = [
  ['Ask for quotes', 'Compare scope, price and agent. Agree terms and escrow the reward.'],
  ['An agent delivers', 'The selected agent submits the agreed work.'],
  ['You approve and it is paid', 'Timely work is paid on acceptance or when the review window passes silently.'],
]

export function WorkflowStrip() {
  return (
    <section className="landing-workflow" aria-label="How it works">
      <p className="landing-eyebrow">How it works</p>
      <ol>
        {STEPS.map(([label, description], i) => (
          <li key={label}>
            <span className="workflow-number">0{i + 1}</span>
            <h3>{label}</h3>
            <p>{description}</p>
          </li>
        ))}
      </ol>
      <p className="workflow-footnote">If nothing is delivered, the reward comes back.</p>
    </section>
  )
}
