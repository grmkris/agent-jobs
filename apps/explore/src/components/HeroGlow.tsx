import { MeshGradient } from '@paper-design/shaders-react'
import { useSyncExternalStore } from 'react'
import { cn } from '../lib/cn.ts'
import { usePrefersReducedMotion, useShaderSlot } from './agent/shader-budget.ts'

/**
 * The page's paper with faint evergreen, sage and sea tints (oklch 0.95–0.96, chroma ≤ 0.03 around the primary's hue
 * 165); the dark theme's ink with the same hues at night. Hex because the shader takes no oklch.
 */
const LIGHT = ['#fafaf9', '#ddf5e9', '#eef5e3', '#dcf4f6']
const DARK = ['#141619', '#112d21', '#0e2628', '#1e2315']

const DARK_QUERY = '(prefers-color-scheme: dark)'
/** The theme the page shows: `[data-theme]` on <html> when set (the widget's `?theme=`), else the system's. */
function useDarkTheme(): boolean {
  return useSyncExternalStore(
    (change) => {
      const query = matchMedia(DARK_QUERY)
      const observer = new MutationObserver(change)
      query.addEventListener('change', change)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
      return () => {
        query.removeEventListener('change', change)
        observer.disconnect()
      }
    },
    () => {
      const forced = document.documentElement.dataset.theme
      return forced === 'dark' || (forced !== 'light' && matchMedia(DARK_QUERY).matches)
    },
    () => false,
  )
}

/**
 * A slow, soft glow behind the landing's prompt: a mesh gradient in the page's own tints, faded to nothing at its
 * edges. It shares the page's shader budget, stands still for anyone who prefers less motion, and without WebGL is
 * the same tints as a CSS gradient. Purely decorative.
 */
export function HeroGlow({ className }: { className?: string }) {
  const colors = useDarkTheme() ? DARK : LIGHT
  const shader = useShaderSlot(true)
  const still = usePrefersReducedMotion()
  return (
    <div
      aria-hidden
      className={cn('pointer-events-none', className)}
      style={{
        maskImage: 'radial-gradient(closest-side, black 35%, transparent)',
        WebkitMaskImage: 'radial-gradient(closest-side, black 35%, transparent)',
      }}
    >
      {shader ? (
        <MeshGradient className="size-full" colors={colors} distortion={1} swirl={0.45} speed={still ? 0 : 0.12} />
      ) : (
        <div
          className="size-full"
          style={{
            background: `radial-gradient(circle at 30% 40%, ${colors[1]}, transparent 60%), radial-gradient(circle at 70% 60%, ${colors[2]}, transparent 60%), radial-gradient(circle at 50% 30%, ${colors[3]}, transparent 55%)`,
          }}
        />
      )}
    </div>
  )
}
