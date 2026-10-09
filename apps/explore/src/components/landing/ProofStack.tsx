import type { ReactNode } from 'react'
import { Check, FileText, GitPullRequest, Package } from 'lucide-react'

function ProofCard({ ask, kind, children }: { ask: string; kind: string; children: ReactNode }) {
  return (
    <article className="proof-card" data-kind={kind}>
      <p className="proof-ask">“{ask}”</p>
      <div className="proof-body">{children}</div>
      <footer className="proof-footer">
        <span className="proof-status">
          <Check aria-hidden="true" />
          Delivered · paid on acceptance
        </span>
        <span className="proof-example">Example</span>
      </footer>
    </article>
  )
}

function PullRequest() {
  return (
    <>
      <div className="proof-meta">
        <GitPullRequest aria-hidden="true" />
        <span>repo / tests / login.spec.ts</span>
      </div>
      <h3 className="proof-code-title">fix: retry race in login test</h3>
      <pre className="proof-diff" aria-label="A three-line diff excerpt">
        <span data-line="removed">- await page.click('#login')</span>
        <span data-line="added">+ await expect(button).toBeEnabled()</span>
        <span data-line="added">+ await button.click()</span>
      </pre>
      <div className="proof-checks">
        <span>
          <Check aria-hidden="true" /> All checks passed
        </span>
        <span className="proof-counts" aria-label="38 lines added, 12 lines removed">
          <span data-line="added">+38</span> <span data-line="removed">−12</span>
        </span>
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
      <div className="proof-meta">
        <Package aria-hidden="true" />
        <span>icons.zip</span>
        <span className="proof-chip">20 PNG · 64 px</span>
      </div>
      <figure
        className="proof-icon-grid"
        data-image-slot="landing-deliverable-icons"
        aria-label="20 pixel-art placeholders: gems, blades, flasks and leaves"
      >
        {ICON_TILES.map(({ id, shape }) => (
          <span key={id} className="proof-icon-tile" aria-hidden="true">
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
      <div className="proof-meta">
        <FileText aria-hidden="true" />
        <span>Public-source memo</span>
        <span className="proof-chip">12 sources</span>
      </div>
      <h3 className="proof-memo-title">
        Fablegrove Labs <span>fictional</span>
      </h3>
      <ul className="proof-findings">
        <li>Two founders listed in public filings.</li>
        <li>One seed round disclosed.</li>
        <li>No public parent company found.</li>
      </ul>
    </>
  )
}

/** Three finished examples fanned beside the prompt. Static mocks only: never listings or evidence of payments. */
export function ProofStack() {
  return (
    <section className="proof-stack" aria-label="Example deliverables">
      <ProofCard ask="Who is behind this startup? Public sources only." kind="research">
        <ResearchMemo />
      </ProofCard>
      <ProofCard ask="Fix the flaky login test in my repo." kind="code">
        <PullRequest />
      </ProofCard>
      <ProofCard ask="Make 20 pixel-art icons for my game." kind="art">
        <IconPack />
      </ProofCard>
    </section>
  )
}
