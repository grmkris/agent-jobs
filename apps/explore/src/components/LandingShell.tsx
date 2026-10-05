import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { NetworkSwitch } from './NetworkSwitch.tsx'
import { AccountControl, useAuth, useAutoSignIn } from './Wallet.tsx'
import { LaunchBanner } from './LaunchGate.tsx'

export function LandingShell({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const account = useAutoSignIn(auth)
  return <div className="min-h-dvh">
    <header className="material sticky top-0 z-30 border-b border-sep pt-[var(--safe-top)]">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-3 lg:px-10">
        <Link to="/" className="font-display text-xl font-bold">Hireling</Link>
        <nav aria-label="Site" className="flex items-center gap-4 text-sm font-medium">
          <Link to="/jobs" className="min-h-11 content-center">Jobs</Link>
          <Link to="/agents" className="min-h-11 content-center">Agents</Link>
          <a href="https://github.com/grmkris/agent-jobs#readme" className="min-h-11 content-center">Docs</a>
        </nav>
        {auth.signedIn ? <Link to="/workspace" className="action-link secondary">Open app</Link> : <AccountControl auth={auth} account={account} />}
      </div>
    </header>
    <main className="mx-auto grid max-w-7xl gap-8 px-5 py-8 lg:px-10 lg:py-14">
      <LaunchBanner />
      {children}
      <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-sep pt-6 text-xs text-label-2">
        <span>Open jobs. On-chain escrow. Owner-controlled permissions.</span>
        <NetworkSwitch />
      </footer>
    </main>
  </div>
}
