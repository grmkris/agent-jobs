import { textLinkClass } from './kit.tsx'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { LaunchBanner } from './LaunchGate.tsx'
import { TestnetEdge, TestnetTag } from './NetworkCue.tsx'
import { Mark } from './Shell.tsx'
import { buttonVariants } from './ui/button.tsx'

/**
 * The public front door: a translucent bar with the brand and one way in ("Open app"), the page, and a footer that
 * links to the documentation and says what the protocol's admin can do.
 */
export function LandingShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <TestnetEdge />
      <header className="material-chrome material-edge-bottom sticky top-0 z-30 pt-[var(--safe-top)]">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 pr-[max(1.25rem,var(--safe-right))] pl-[max(1.25rem,var(--safe-left))]">
          <span className="flex min-w-0 items-center gap-2">
            <Link to="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <Mark />
              Sidequest
            </Link>
            <TestnetTag />
          </span>
          <span className="flex items-center gap-4"><a href="/docs" className={textLinkClass}>Docs</a><Link to="/jobs" className={buttonVariants({ variant: 'outline' })}>
            Open app
          </Link></span>
        </div>
      </header>
      <main className="mx-auto grid max-w-5xl gap-16 pt-12 pr-[max(1.25rem,var(--safe-right))] pb-[max(3rem,var(--safe-bottom))] pl-[max(1.25rem,var(--safe-left))] sm:pt-24">
        <LaunchBanner />
        {children}
        <footer className="border-t pt-6 text-xs text-muted-foreground">
          <span>
            Rewards are escrowed on Monad; the protocol's admin keeps pause and upgrade powers.{' '}
            <a className={textLinkClass} href="/docs/trust">
              Protocol and admin powers
            </a>
          </span>
        </footer>
      </main>
    </div>
  )
}
