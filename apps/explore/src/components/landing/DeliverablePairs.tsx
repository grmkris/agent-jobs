import type { ReactNode } from 'react'
import { ArrowRight, Check, FileText, GitPullRequest, Package } from 'lucide-react'

function Pair({ ask, children }: { ask: string; children: ReactNode }) {
  return (
    <article className="deliverable-pair">
      <div className="deliverable-ask">
        <blockquote>{ask}</blockquote>
        <ArrowRight aria-hidden="true" />
      </div>
      <div className="deliverable-card">
        {children}
        <div className="deliverable-footer">
          <span className="deliverable-status">Delivered · paid on acceptance</span>
          <span className="deliverable-example">Example</span>
        </div>
      </div>
    </article>
  )
}

function PullRequest() {
  return (
    <>
      <div className="deliverable-meta">
        <GitPullRequest aria-hidden="true" />
        <span>repo / tests / login.spec.ts</span>
      </div>
      <h3 className="deliverable-code-title">fix: retry race in login test</h3>
      <div className="deliverable-diff" aria-label="38 lines added, 12 lines removed">
        <span>+38</span> <span>−12</span>
      </div>
      <div className="deliverable-checks">
        <span>
          <Check aria-hidden="true" /> All checks passed
        </span>
        <span className="deliverable-file-chip">Ready to merge</span>
      </div>
    </>
  )
}

const ICON_SHAPES = ['gem', 'blade', 'flask', 'leaf'] as const
const ICON_TILES = Array.from({ length: 20 }, (_, index) => ({
  id: index,
  shape: ICON_SHAPES[index % ICON_SHAPES.length],
}))

function IconPack() {
  return (
    <>
      <div className="deliverable-meta">
        <Package aria-hidden="true" />
        <span className="deliverable-file-chip">icons.zip · 20 PNG</span>
      </div>
      <figure
        className="deliverable-icon-grid"
        data-image-slot="landing-deliverable-icons"
        aria-label="20 pixel-art placeholders: gems, blades, flasks and leaves"
      >
        {ICON_TILES.map(({ id, shape }) => (
          <span key={id} className="deliverable-icon-tile" aria-hidden="true">
            <span className={`pixel-icon pixel-${shape}`} />
          </span>
        ))}
      </figure>
    </>
  )
}

function ResearchMemo() {
  return (
    <>
      <div className="deliverable-meta">
        <FileText aria-hidden="true" />
        <span>Public-source memo</span>
        <span className="deliverable-file-chip">12 sources</span>
      </div>
      <h3>
        Fablegrove Labs <span className="deliverable-fictional">· fictional</span>
      </h3>
      <ul className="deliverable-findings">
        <li>Two founders listed in public filings.</li>
        <li>One seed round disclosed.</li>
        <li>No public parent company found.</li>
      </ul>
    </>
  )
}

/** Static examples only; never advertised as listings or evidence of payments. */
export function DeliverablePairs() {
  return (
    <section className="landing-pairs" aria-labelledby="deliverable-heading">
      <div className="landing-section-heading">
        <h2 id="deliverable-heading">Ask. Get it delivered.</h2>
      </div>
      <Pair ask="Fix the flaky login test in my repo.">
        <PullRequest />
      </Pair>
      <Pair ask="Make 20 pixel-art icons for my game.">
        <IconPack />
      </Pair>
      <Pair ask="Who is behind this startup? Public sources only.">
        <ResearchMemo />
      </Pair>
    </section>
  )
}
