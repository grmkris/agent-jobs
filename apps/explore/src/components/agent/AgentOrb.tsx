import { MeshGradient, PulsingBorder } from '@paper-design/shaders-react'
import { cn } from '../../lib/cn.ts'
import { type AgentLiveness, orbGradient, orbPalette } from '../../agent-orb.ts'
import { usePrefersReducedMotion, useShaderSlot } from './shader-budget.ts'

const SIZE = { sm: 'size-5', md: 'size-10', lg: 'size-18' } as const
const LIVE = ['hsl(142, 71%, 45%)', 'hsl(152, 76%, 60%)', 'hsl(160, 84%, 39%)']
const CLEAR = '#00000000'

/**
 * An agent's mark: a slow mesh gradient in colours seeded by its Agent ID, ringed while it is live or working. The md
 * and lg orbs draw with WebGL while the page has a shader slot free (see shader-budget); the sm orb in chips and rows,
 * and any orb past the budget, is the same gradient in CSS, so small chips never take the slots a page's main orb
 * needs. It stands still when idle or when the person prefers less motion. Decorative only: it renders no text.
 */
export function AgentOrb({ agentId, size = 'md', status = 'idle', className }: { agentId: string; size?: keyof typeof SIZE; status?: AgentLiveness; className?: string }) {
  const palette = orbPalette(agentId)
  const still = usePrefersReducedMotion()
  const moving = !still && status !== 'idle'
  const orb = useShaderSlot(size !== 'sm')
  // A ring shader is worth a WebGL context only around the larger orbs; small ones get the CSS ring.
  const ringShader = useShaderSlot(status !== 'idle' && size !== 'sm')
  return (
    <span aria-hidden className={cn('relative inline-block shrink-0 rounded-full', SIZE[size], className)}>
      {status !== 'idle' &&
        (ringShader ? (
          <PulsingBorder
            className="absolute -inset-[18%]"
            colors={status === 'live' ? LIVE : palette.slice(0, 3)}
            colorBack={CLEAR}
            aspectRatio="square"
            roundness={1}
            thickness={0.06}
            softness={0.75}
            intensity={0.25}
            bloom={0.35}
            spots={3}
            spotSize={0.4}
            pulse={status === 'working' ? 0.5 : 0.2}
            smoke={0}
            scale={1}
            speed={moving ? (status === 'working' ? 1 : 0.4) : 0}
          />
        ) : (
          <span
            className={cn(
              'absolute -inset-[3px] rounded-full ring-2',
              status === 'live' ? 'ring-success/60' : 'ring-primary/50 motion-safe:animate-pulse',
            )}
          />
        ))}
      {orb ? (
        <MeshGradient className="size-full overflow-hidden rounded-full" colors={palette} distortion={0.8} swirl={0.3} speed={moving ? 0.25 : 0} />
      ) : (
        <span className="block size-full rounded-full" style={{ background: orbGradient(palette) }} />
      )}
    </span>
  )
}
