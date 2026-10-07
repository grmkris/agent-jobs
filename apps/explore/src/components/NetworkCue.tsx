import { cn } from '../lib/cn.ts'
import { isMainnet } from '../wallet.ts'
import { Badge } from './ui/badge.tsx'

/*
 * How testnet marks itself; mainnet carries no marker. Each network has its own origin and they never link to each
 * other, so this is a label, not a switch.
 */

/** "TESTNET" beside the brand. */
export function TestnetTag({ className }: { className?: string }) {
  if (isMainnet) return null
  return (
    <Badge variant="warning" className={cn('text-micro font-semibold uppercase tracking-wide', className)}>
      Testnet
    </Badge>
  )
}

/**
 * A 2px amber edge across the top of the window, just under the status bar in an installed app. At 2px it stays under
 * Safari 26's 3px threshold for sampling the status bar's tint, so the clock area keeps the page colour.
 */
export function TestnetEdge() {
  if (isMainnet) return null
  return <div aria-hidden className="pointer-events-none fixed inset-x-0 top-(--safe-top) z-40 h-0.5 bg-warning" />
}
