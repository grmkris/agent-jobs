export function SectionHeading({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="landing-section-heading">
      <p className="landing-eyebrow">{kicker}</p>
      <h2>{title}</h2>
    </div>
  )
}
