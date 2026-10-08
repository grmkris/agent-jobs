import type { MissionKind } from './mission-data.ts'

/** Named slots for future generated images. These illustrations contain no listing or delivery claims. */
export function MissionArt({ kind }: { kind: MissionKind }) {
  return (
    <div className={`mission-art mission-art-${kind}`} data-image-slot={`landing-mission-${kind}`} aria-hidden="true">
      <svg viewBox="0 0 320 180" fill="none" className="mission-art-svg">
        <Artwork kind={kind} />
      </svg>
    </div>
  )
}

function Artwork({ kind }: { kind: MissionKind }) {
  switch (kind) {
    case 'code':
      return <CodeArt />
    case 'research':
      return <ResearchArt />
    case 'audit':
      return <AuditArt />
    case 'assets':
      return <AssetArt />
    case 'travel':
      return <TravelArt />
    case 'report':
      return <ReportArt />
  }
}

function CodeArt() {
  return (
    <>
      <rect x="31" y="24" width="258" height="140" rx="8" className="art-paper art-outline" />
      <path d="M31 52H289" className="art-outline" />
      <circle cx="47" cy="38" r="3" className="art-ink" />
      <circle cx="59" cy="38" r="3" className="art-muted" />
      <text x="75" y="42" className="art-caption">
        a fix, ready for review
      </text>
      <rect x="45" y="64" width="230" height="19" rx="3" className="art-wash" />
      <text x="53" y="77" className="art-code">
        + if (result.ok) return result
      </text>
      <rect x="45" y="89" width="230" height="19" rx="3" className="art-wash" />
      <text x="53" y="102" className="art-code">
        + await verify(response)
      </text>
      <path d="M53 121H162M53 135H199M53 149H131" className="art-outline" strokeWidth="4" />
      <circle cx="257" cy="139" r="14" className="art-ink" />
      <path d="m250 139 5 5 9-10" className="art-inverse-stroke" strokeWidth="2" />
    </>
  )
}

function ResearchArt() {
  return (
    <>
      <g transform="rotate(-6 145 94)">
        <rect x="48" y="22" width="183" height="145" rx="3" className="art-muted" />
      </g>
      <g transform="rotate(4 159 91)">
        <rect x="68" y="17" width="183" height="148" rx="3" className="art-paper art-outline" />
        <text x="84" y="40" className="art-caption">
          THE RESEARCH FILE
        </text>
        <path d="M85 55H193" className="art-ink-stroke" strokeWidth="7" />
        <rect x="82" y="68" width="153" height="12" className="art-wash" />
        <path d="M86 73H227M86 93H218M86 107H224M86 121H180M86 145H151" className="art-outline" strokeWidth="3" />
        <circle cx="233" cy="123" r="21" className="art-paper art-ink-stroke" strokeWidth="2" />
        <path d="m249 139 20 20" className="art-ink-stroke" strokeWidth="7" strokeLinecap="round" />
      </g>
      <path d="M36 50Q19 62 35 75" className="art-ink-stroke" />
      <text x="19" y="95" className="art-caption">
        sources
      </text>
    </>
  )
}

function AuditArt() {
  return (
    <>
      <rect x="32" y="23" width="255" height="133" rx="6" className="art-paper art-outline" />
      <path d="M32 47H287" className="art-outline" />
      <circle cx="46" cy="35" r="3" className="art-muted" />
      <rect x="49" y="61" width="104" height="64" rx="3" className="art-wash" />
      <path d="M171 69H266M171 83H244M171 97H262M171 111H226" className="art-outline" strokeWidth="4" />
      <rect
        x="158"
        y="57"
        width="120"
        height="37"
        rx="4"
        className="art-warning-stroke"
        strokeWidth="2"
        strokeDasharray="4 3"
      />
      <path d="M226 97V121H179" className="art-warning-stroke" strokeWidth="2" />
      <rect x="142" y="123" width="136" height="30" rx="3" className="art-paper art-outline" />
      <text x="153" y="142" className="art-caption">
        finding + evidence
      </text>
    </>
  )
}

function AssetArt() {
  return (
    <>
      <path
        d="M33 35H287M33 89H287M33 143H287M69 22V161M130 22V161M191 22V161M252 22V161"
        className="art-outline"
        strokeDasharray="2 5"
      />
      {[62, 147, 233].map((x) => (
        <g key={x} transform={`translate(${x} 36)`}>
          <path d="M0 28H7V14H14V7H28V0H35V7H42V14H49V28H56V35H42V42H14V35H0Z" className="art-ink" />
          <path d="M21 35H35V63H21Z" className="art-muted" />
          <path d="M14 14H21V7H28V14H35V21H14Z" className="art-wash" />
        </g>
      ))}
      <path d="M48 145V131H55V124H69V131H76V145H48ZM132 145V131H139V124H153V131H160V145H132Z" className="art-ink" />
      <path d="M227 146V128H234V121H248V128H255V146Z" className="art-muted" />
      <path d="m270 104 4 9 10 4-10 4-4 9-4-9-10-4 10-4Z" className="art-ink" />
    </>
  )
}

function TravelArt() {
  return (
    <>
      <path d="m35 42 83-15 89 18 79-17v121l-79 16-89-18-83 14Z" className="art-paper art-outline" />
      <path d="M118 27V147M207 45V165" className="art-outline" />
      <path d="m39 134 63-61 38 54 35-64 39 65 68-77" className="art-muted-stroke" strokeWidth="18" />
      <path
        d="M67 116C70 70 113 66 144 109S201 143 249 75"
        className="art-ink-stroke"
        strokeWidth="3"
        strokeDasharray="5 5"
      />
      <circle cx="67" cy="116" r="7" className="art-ink" />
      <circle cx="144" cy="109" r="7" className="art-ink" />
      <path d="M238 62a11 11 0 0 1 22 0c0 9-11 20-11 20s-11-11-11-20Z" className="art-ink" />
      <circle cx="249" cy="61" r="4" className="art-paper" />
    </>
  )
}

function ReportArt() {
  return (
    <>
      <rect x="51" y="27" width="81" height="51" rx="2" transform="rotate(-9 51 27)" className="art-wash art-outline" />
      <path d="M60 37 113 30M61 49 108 42M64 60 97 54" className="art-outline" strokeWidth="3" />
      <rect x="35" y="97" width="83" height="45" rx="2" transform="rotate(7 35 97)" className="art-paper art-outline" />
      <path d="m45 111 56 7m-57 4 47 6" className="art-outline" strokeWidth="3" />
      <path d="M128 91H159m-7-7 7 7-7 7" className="art-ink-stroke" strokeWidth="2" />
      <rect x="173" y="24" width="110" height="139" rx="3" className="art-paper art-outline" />
      <text x="187" y="43" className="art-caption">
        A CLEARER PICTURE
      </text>
      <path d="M187 59H262M187 70H249M187 140H261M187 150H238" className="art-outline" strokeWidth="3" />
      <rect x="188" y="101" width="14" height="25" className="art-wash" />
      <rect x="210" y="89" width="14" height="37" className="art-muted" />
      <rect x="232" y="78" width="14" height="48" className="art-ink" />
    </>
  )
}
