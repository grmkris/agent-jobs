import { ArrowUpRight, Rotate3d } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ModelRef } from '../../delivery-plan.ts'
import { fetchModel } from '../../model-fetch.ts'
import { usePrefersReducedMotion } from '../agent/shader-budget.ts'
import { Spinner } from '../ui/spinner.tsx'
import { KindGlyph } from './KindGlyph.tsx'

/** An STL's colour, which it does not carry: a teal that reads on light and dark cards. */
const STL_COLOR = '#3f9c9a'

/**
 * A delivered 3D model, turning in the card: its bytes fetched and the three.js scene loaded only now. One open card
 * holds one WebGL context, beside the orbs' capped few (shader-budget.ts), so it takes none of their slots. Anything
 * that stops it (no WebGL, the host refusing a cross-origin read, a file too big, a format it cannot parse) leaves the
 * model as a file to open.
 */
export function ModelView({ model, href }: { model: ModelRef; href: string | null }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const still = usePrefersReducedMotion()
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  useEffect(() => {
    const node = canvas.current
    if (node === null) return
    const abort = new AbortController()
    let live = true
    let dispose: (() => void) | undefined
    Promise.all([import('./model-scene.ts'), fetchModel(model.src, abort.signal)])
      .then(([scene, buffer]) =>
        scene.mountModel(node, buffer, { format: model.format, base: model.src, still, color: STL_COLOR }),
      )
      .then((stop) => {
        if (!live) return stop()
        dispose = stop
        setState('ready')
      })
      .catch(() => {
        if (live) setState('failed')
      })
    return () => {
      live = false
      abort.abort()
      dispose?.()
    }
  }, [model.src, model.format, still])
  if (state === 'failed')
    return (
      <span className="relative block size-full">
        <KindGlyph kind="artifact" model label="3D model" detail={model.name} className="size-full" />
        {href !== null && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-full bg-background/80 px-2 py-0.5 text-[11px] font-medium"
          >
            Open the file
            <ArrowUpRight aria-hidden className="size-3" />
          </a>
        )}
      </span>
    )
  return (
    <span className="relative block size-full bg-[radial-gradient(120%_100%_at_50%_0%,var(--color-muted),transparent)]">
      <canvas ref={canvas} aria-hidden className="block size-full cursor-grab touch-none active:cursor-grabbing" />
      <span className="sr-only">3D model {model.name}</span>
      {state === 'loading' ? (
        <span className="absolute inset-0 grid place-items-center text-muted-foreground">
          <Spinner />
        </span>
      ) : (
        <span className="pointer-events-none absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-background/75 px-2 py-0.5 text-[11px] text-muted-foreground">
          <Rotate3d aria-hidden className="size-3" />
          Drag to turn
        </span>
      )}
    </span>
  )
}
