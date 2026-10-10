import { ArrowUpRight, Rotate3d } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { Deliverable } from '../../api.ts'
import { type PreviewPlan, thumbOf } from '../../delivery-plan.ts'
import { KIND, deliveryWhere } from '../../delivery.ts'
import { DeliveryImage } from './DeliveryImage.tsx'
import { KindGlyph } from './KindGlyph.tsx'
import { ModelView } from './ModelView.tsx'

const BOX = 'aspect-[16/9] w-full'

/** The visual as a link to the delivery when it has a web address; it opens in a new tab, sending no referrer. */
function Opens({ href, children }: { href: string | null; children: ReactNode }) {
  if (href === null) return <div className="relative">{children}</div>
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group relative block outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
    >
      {children}
      <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-foreground/75 px-2 py-0.5 text-[11px] font-medium text-background opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100">
        Open
        <ArrowUpRight aria-hidden className="size-3" />
      </span>
    </a>
  )
}

/** A site's poster, with a button that turns the model it delivered instead. */
function PosterWithModel({ poster, model }: { poster: ReactNode; model: ReactNode }) {
  const [turning, setTurning] = useState(false)
  if (turning) return <div className={BOX}>{model}</div>
  return (
    <div className="relative">
      {poster}
      <button
        type="button"
        onClick={() => setTurning(true)}
        className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 rounded-full bg-background/85 px-2.5 py-1 text-xs font-medium shadow-sm ring-1 ring-foreground/10 hover:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden"
      >
        <Rotate3d aria-hidden className="size-3.5" />
        View in 3D
      </button>
    </div>
  )
}

/**
 * What was delivered, at the top of its receipt: a picture of it (the curated image, its own poster, the image file),
 * a 3D model turning (or a site's poster with a button to turn the model it delivered), else a glyph for its kind.
 */
export function DeliveryPreview({ plan, deliverable }: { plan: PreviewPlan; deliverable: Deliverable | null }) {
  if (plan.from === 'model')
    return (
      <div className={BOX}>
        <ModelView model={plan.model} href={plan.href} />
      </div>
    )
  const glyph = (
    <KindGlyph
      kind={deliverable?.kind ?? null}
      media={plan.from === 'glyph' ? plan.media : null}
      label={deliverable === null ? 'Delivery' : KIND[deliverable.kind]}
      detail={deliverable === null ? '' : deliveryWhere(deliverable)}
      className={BOX}
    />
  )
  const thumb = thumbOf(plan)
  const picture = (
    <Opens href={plan.href}>
      {thumb === null ? glyph : <DeliveryImage thumb={thumb} icons={16} className={BOX} fallback={glyph} />}
    </Opens>
  )
  if (plan.from === 'poster' && plan.model !== null)
    return <PosterWithModel poster={picture} model={<ModelView model={plan.model} href={plan.model.src} />} />
  return picture
}
