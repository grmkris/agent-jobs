import { ArrowUpRight } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Deliverable } from '../../api.ts'
import { type PreviewPlan, thumbOf } from '../../delivery-plan.ts'
import { KIND, deliveryWhere } from '../../delivery.ts'
import { DeliveryImage } from './DeliveryImage.tsx'
import { KindGlyph } from './KindGlyph.tsx'

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

/**
 * What was delivered, at the top of its receipt: a picture of it (the curated image, its own poster, the image
 * file), else a glyph for its kind. `extra` renders under the picture, inside the frame (the 3D view's button).
 */
export function DeliveryPreview({
  plan,
  deliverable,
  model,
}: {
  plan: PreviewPlan
  deliverable: Deliverable | null
  /** The 3D view, when the plan has a model to turn. */
  model?: ReactNode
}) {
  const glyph = (
    <KindGlyph
      kind={deliverable?.kind ?? null}
      media={plan.from === 'glyph' ? plan.media : null}
      model={plan.from === 'model'}
      label={plan.from === 'model' ? '3D model' : deliverable === null ? 'Delivery' : KIND[deliverable.kind]}
      detail={plan.from === 'model' ? plan.model.name : deliverable === null ? '' : deliveryWhere(deliverable)}
      className={BOX}
    />
  )
  if (plan.from === 'model' && model !== undefined) return <div className={BOX}>{model}</div>
  const thumb = thumbOf(plan)
  return (
    <Opens href={plan.href}>
      {thumb === null ? glyph : <DeliveryImage thumb={thumb} icons={16} className={BOX} fallback={glyph} />}
    </Opens>
  )
}
