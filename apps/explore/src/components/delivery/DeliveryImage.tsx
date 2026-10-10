import { Play } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import type { Thumb } from '../../delivery-plan.ts'
import { ICON_PACK, showcaseShot } from '../landing/showcase-images.ts'

/** The curated job's vendored image, or the delivery's own poster or image from its host (never sent a referrer). */
const srcOf = (thumb: Thumb): string | null =>
  'src' in thumb ? thumb.src : (showcaseShot(thumb.showcase.delivered.jobId) ?? null)

/** The icon pack as delivered: its first PNGs, pixel for pixel; a fuller sheet in a bigger frame. */
function IconSheet({ count }: { count: number }) {
  const big = count > 8
  return (
    <span
      className={cn('grid size-full place-items-center gap-1 bg-muted p-2', big ? 'grid-cols-8' : 'grid-cols-4 p-1')}
    >
      {ICON_PACK.slice(0, count).map((src) => (
        <img
          key={src}
          src={src}
          alt=""
          className={cn('size-full [image-rendering:pixelated]', big ? 'max-h-8 max-w-8' : 'max-h-6 max-w-6')}
        />
      ))}
    </span>
  )
}

/**
 * A delivery's picture, filling its box: the image (top-anchored, as a page's top is what identifies it) with a play
 * mark for audio and video, which never play here. A picture that fails to load leaves the box to `fallback`.
 */
export function DeliveryImage({
  thumb,
  className,
  icons = 8,
  fallback = null,
}: {
  thumb: Thumb
  className?: string
  icons?: number
  fallback?: ReactNode
}) {
  const [failed, setFailed] = useState(false)
  const src = srcOf(thumb)
  if (failed) return fallback
  return (
    <span className={cn('relative block overflow-hidden bg-muted', className)}>
      {src === null ? (
        <IconSheet count={icons} />
      ) : (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="size-full object-cover object-top"
        />
      )}
      {thumb.media && (
        <span className="absolute inset-0 grid place-items-center bg-foreground/10">
          <span className="grid size-[38%] max-h-10 min-h-4 max-w-10 min-w-4 place-items-center rounded-full bg-foreground/70 text-background">
            <Play aria-hidden className="size-1/2 fill-current" />
          </span>
        </span>
      )}
    </span>
  )
}
