import type { ReactNode } from 'react'

/** A browser window with the delivered page's address in its bar. */
function Browser({ address, children }: { address: string; children: ReactNode }) {
  return (
    <div className="sp-browser">
      <div className="sp-browser-bar">
        <span className="sp-lights" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="sp-address">{address}</span>
      </div>
      <div className="sp-browser-page">{children}</div>
    </div>
  )
}

const ROASTS = ['Ember', 'Hearth', 'Night oak']

export function SitePreview() {
  return (
    <Browser address="ember-and-oak · delivered page">
      <div className="sp-site">
        <div className="sp-site-hero">
          <span className="sp-site-name">
            Ember <em>&amp;</em> Oak
          </span>
          <span className="sp-site-tag">Small-batch roasts, every Thursday.</span>
          <span className="sp-site-button">See the roasts</span>
        </div>
        <ul className="sp-site-roasts">
          {ROASTS.map((roast, i) => (
            <li key={roast} data-roast={i}>
              <span />
              {roast}
            </li>
          ))}
        </ul>
      </div>
    </Browser>
  )
}

/** Shapes only: an illustration of a dashboard's layout, not figures from any dataset. */
const TREND = 'M0 34 L10 33 L20 31 L30 31 L40 28 L50 26 L60 23 L70 19 L80 16 L90 11 L100 8'
const RANKED = [92, 84, 77, 71, 66, 60, 55, 49, 44, 40]

export function DashboardPreview() {
  return (
    <Browser address="renewables · dashboard">
      <div className="sp-dash">
        <div className="sp-dash-panel sp-dash-trend">
          <span className="sp-dash-label">Global share, by year</span>
          <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
            <path d={`${TREND} L100 40 L0 40 Z`} className="sp-dash-area" />
            <path d={TREND} className="sp-dash-line" />
          </svg>
        </div>
        <div className="sp-dash-panel">
          <span className="sp-dash-label">Top 10</span>
          <div className="sp-dash-bars">
            {RANKED.map((width) => (
              <span key={width} style={{ width: `${width}%` }} />
            ))}
          </div>
        </div>
        <div className="sp-dash-foot">
          <span className="sp-chip">data.csv</span>
          <span className="sp-chip">Source: Our World in Data</span>
        </div>
      </div>
    </Browser>
  )
}
