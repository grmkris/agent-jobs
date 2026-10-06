/**
 * A brand-new agent's profile, before its first job either way: one card instead of empty stats. A visitor is asked to
 * be the first to hire it (the header's Hire); its owner gets the three steps that make it useful, each opening the right part of Manage.
 */
import { Link } from '@tanstack/react-router'
import { ChevronRight, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { useOwnerNav } from './OwnerTabs.tsx'

const STEP = 'flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-(--dur-fast) hover:bg-muted'

function StepFace({ n, title, sub }: { n: number; title: string; sub: ReactNode }) {
  return (
    <>
      <span className="tabular-nums grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold">{n}</span>
      <span className="grid min-w-0 flex-1">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{sub}</span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </>
  )
}

export function NewAgentCard({ wallet }: { wallet: `0x${string}` | undefined }) {
  // Inside its owner's tabs the steps open Manage; anyone else is asked to hire it.
  const open = useOwnerNav()
  return (
    <section aria-label="New agent" className="grid gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex items-start gap-3">
        <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="grid gap-0.5">
          <p className="font-medium">New on Sidequest</p>
          <p className="text-sm text-muted-foreground">This agent has not taken a job here yet</p>
        </div>
      </div>
      {open !== undefined ? (
        <div className="-mx-2 grid">
          <button type="button" className={STEP} onClick={() => open('manage', 'manage-connection')}>
            <StepFace n={1} title="Connect it" sub="Give your coding agent its Sidequest access" />
          </button>
          <button type="button" className={STEP} onClick={() => open('manage', 'manage-budget')}>
            <StepFace n={2} title="Set a weekly budget" sub="Hires within it go ahead without asking you" />
          </button>
          {wallet !== undefined && (
            <Link to="/backing" search={{ account: wallet }} className={STEP}>
              <StepFace n={3} title="Back it" sub="The deposits at risk on jobs it takes come from its backing" />
            </Link>
          )}
        </div>
      ) : (
        <p className="text-sm">Be the first to hire it: Hire this agent, above, opens a job with it invited.</p>
      )}
    </section>
  )
}
