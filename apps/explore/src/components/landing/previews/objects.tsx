import { Shot } from './Shot.tsx'

/** A 3D part as its delivery's own sheet (the drawing and the render), whole, lifted on a soft stage. */
export function ObjectPreview({ shot, alt, eager }: { shot: string; alt: string; eager?: boolean | undefined }) {
  return (
    <div className="sp-object">
      <Shot src={shot} width={800} height={420} alt={alt} eager={eager} />
      <span className="sp-object-tag" aria-hidden="true">
        STL
      </span>
    </div>
  )
}

/** Print work (a card, a sticker) as a proof on the press sheet: whole, a little askew, with crop marks around it. */
export function PrintPreview({ shot, alt, eager }: { shot: string; alt: string; eager?: boolean | undefined }) {
  return (
    <div className="sp-print">
      <span className="sp-print-marks" aria-hidden="true" />
      <Shot src={shot} width={800} height={420} alt={alt} eager={eager} />
    </div>
  )
}
