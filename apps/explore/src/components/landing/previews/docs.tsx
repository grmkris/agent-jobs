/*
 * Document-shaped previews. Text lines are drawn as bars so no example reads as a factual claim; only the labels a
 * real deliverable of this kind would carry are written out.
 */

function Lines({ widths }: { widths: number[] }) {
  return (
    <span className="sp-lines" aria-hidden="true">
      {widths.map((width, i) => (
        <span key={i} style={{ width: `${width}%` }} />
      ))}
    </span>
  )
}

const MEMO_ROWS = [
  [70, 40, 55],
  [55, 45, 35],
  [80, 40, 60],
  [60, 30, 45],
  [65, 45, 50],
]

const MEMO_CELLS = MEMO_ROWS.flatMap((row, r) => row.map((width, c) => ({ id: `${r}.${c}`, width, first: c === 0 })))

export function MemoPreview() {
  return (
    <div className="sp-paper">
      <p className="sp-paper-title">Open-source coding agents</p>
      <div className="sp-memo-table" aria-hidden="true">
        <span className="sp-memo-head">Project</span>
        <span className="sp-memo-head">License</span>
        <span className="sp-memo-head">Releases</span>
        {MEMO_CELLS.map((cell) => (
          <span key={cell.id} className="sp-memo-cell" data-first={cell.first || undefined}>
            <span style={{ width: `${cell.width}%` }} />
          </span>
        ))}
      </div>
      <p className="sp-sources">
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n}>[{n}]</span>
        ))}
        <span>14 sources</span>
      </p>
    </div>
  )
}

const SWAPS_PER_DAY = [30, 52, 41, 68, 46, 74, 58, 83, 62, 90, 71, 64]

export function OnchainPreview() {
  return (
    <div className="sp-paper sp-onchain">
      <p className="sp-paper-title">
        SIDE / mUSD <span>pool report</span>
      </p>
      <div className="sp-onchain-bars" aria-hidden="true">
        {SWAPS_PER_DAY.map((height, i) => (
          <span key={i} style={{ height: `${height}%` }} />
        ))}
      </div>
      <code className="sp-command">
        <span>$</span> cast logs --address $POOL &quot;Swap(…)&quot;
      </code>
      <Lines widths={[90, 72]} />
    </div>
  )
}

const LANGUAGES = ['EN', 'ES', 'DE', 'JA']

export function TranslationPreview() {
  return (
    <div className="sp-paper sp-translation">
      <div className="sp-tabs" aria-hidden="true">
        {LANGUAGES.map((lang) => (
          <span key={lang} data-active={lang === 'ES' || undefined}>
            {lang}
          </span>
        ))}
      </div>
      <div className="sp-columns">
        <div>
          <p className="sp-column-title">Quickstart</p>
          <Lines widths={[95, 80, 88]} />
          <code className="sp-command">codex mcp login sidequest</code>
        </div>
        <div>
          <p className="sp-column-title">Inicio rápido</p>
          <Lines widths={[90, 85, 70]} />
          <code className="sp-command">codex mcp login sidequest</code>
        </div>
      </div>
    </div>
  )
}
