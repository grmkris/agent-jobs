/**
 * The app's frame, around two places: Jobs (every board's work, quotes and workers) and Agents (the operator's own).
 * On a wide screen: a sidebar with both, the operator's agents nested under Agents with what each waits on, and the
 * account menu at its foot. On a phone: a translucent top bar and a tab bar (Jobs, Agents, Account), clear of the
 * notch and the home indicator. Content scrolls under the translucent chrome.
 */
import { Link, useLocation } from '@tanstack/react-router'
import { Bot, BriefcaseBusiness, CircleUserRound, type LucideIcon, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { currentBoardId } from '../api.ts'
import { agentHome, pendingByAgent, useManagedAgents, useManagedApprovals } from '../managed.ts'
import { isMainnet, usePaused } from '../wallet.ts'
import { AccountMenu, Count } from './AccountMenu.tsx'
import { type LinkTarget, BoardLink, boardRoutes } from './BoardLink.tsx'
import { LaunchBanner } from './LaunchGate.tsx'
import { NetworkSwitch } from './NetworkSwitch.tsx'
import { cn } from './ui.tsx'
import { useCollectActions } from '../collect.ts'
import { AccountControl, Monogram, useAuth, useAutoSignIn } from './Wallet.tsx'

interface Place {
  label: string
  icon: LucideIcon
  target: LinkTarget
  /** Whether the current path belongs to this place. */
  active: (path: string) => boolean
}

/** Pages that belong to the account rather than to a job or an agent. */
const ACCOUNT_PATHS = ['/account', '/collect', '/backing', '/sponsorship', '/telegram', '/admin']
const AGENT_PATHS = ['/agents', '/connect']
const onAccount = (p: string) => ACCOUNT_PATHS.some((a) => p.startsWith(a))

/**
 * Jobs, Agents and (on a phone) Account. An agent's page belongs to Agents when it is one of the operator's own
 * (`mine`), and to Jobs otherwise: a worker reached from Jobs › Workers.
 */
function places(mine: ReadonlySet<string>): Place[] {
  const r = boardRoutes()
  const ownAgent = (p: string) => {
    const id = /\/agent\/([0-9]+)$/.exec(p)?.[1]
    return id !== undefined && mine.has(id)
  }
  const agents = (p: string) => AGENT_PATHS.some((a) => p.startsWith(a)) || ownAgent(p)
  return [
    { label: 'Jobs', icon: BriefcaseBusiness, target: r.boardId === 'public' ? { to: '/jobs' } : r.jobs(), active: (p) => p !== '/' && !agents(p) && !onAccount(p) },
    { label: 'Agents', icon: Bot, target: { to: '/agents' }, active: agents },
    { label: 'Account', icon: CircleUserRound, target: { to: '/account' }, active: onAccount },
  ]
}

/** The brand mark (src/brand/mark.svg), in the tint so it follows light, dark and a tint change. */
export function Mark() {
  return (
    <svg aria-hidden viewBox="0 0 32 32" className="size-6 shrink-0">
      <rect width="32" height="32" rx="7" className="fill-tint" />
      <path d="M10 8v16M22 8v16M10 16h12" className="stroke-on-tint" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  )
}

function Brand() {
  const boardId = currentBoardId()
  return (
    <Link to="/" className="flex min-h-11 min-w-0 items-center gap-2 text-base font-semibold tracking-tight">
      <Mark />
      <span className="truncate">
        Hireling
        {boardId !== 'public' && <span className="font-normal text-muted-foreground"> · {boardId}</span>}
      </span>
    </Link>
  )
}

function TestTokens() {
  if (isMainnet) return null
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="size-1.5 rounded-full bg-warning" />
      Test tokens, no real value
    </span>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const account = useAutoSignIn(auth)
  const paused = usePaused()
  const { pathname } = useLocation()
  const managed = useManagedAgents()
  const approvals = useManagedApprovals()
  const agents = auth.signedIn ? (managed.data?.agents ?? []) : []
  const pending = pendingByAgent(auth.signedIn ? (approvals.data?.approvals ?? []) : [])
  const waiting = [...pending.values()].reduce((sum, n) => sum + n, 0)
  const mine = new Set(agents.flatMap((a) => (a.agent_id === null ? [] : [String(a.agent_id)])))
  const [jobs, agentsPlace, accountPlace] = places(mine)
  // Nothing is counted when unknown.
  const collect = useCollectActions(auth.address, auth.signedIn).data?.length ?? 0
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-1 overflow-y-auto border-r bg-sidebar px-3 pt-4 pb-4 text-sidebar-foreground lg:flex" aria-label="Sections">
        <div className="px-2 pb-4">
          <Brand />
        </div>
        <nav className="grid gap-0.5" aria-label="Places">
          {jobs !== undefined && <SideItem place={jobs} on={jobs.active(pathname)} />}
          {agentsPlace !== undefined && <SideItem place={agentsPlace} on={agentsPlace.active(pathname) && !(auth.signedIn && pathname === '/agents/new') && !agents.some((a) => onAgent(pathname, a.agent_id))} count={waiting > 0 ? <Count n={waiting} kind="waiting" /> : null} />}
          {auth.signedIn && (
            <ul className="ml-4.5 grid gap-0.5 border-l border-sidebar-border pl-2" aria-label="Your agents">
              {agents.map((agent) => {
                const n = pending.get(agent.id) ?? 0
                const on = onAgent(pathname, agent.agent_id)
                return (
                  <li key={agent.id}>
                    <BoardLink target={agentHome(agent)} aria-current={on ? 'page' : undefined} className={sideClass(on, true)}>
                      <Monogram seed={agent.agent_id ?? agent.id} />
                      <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                      {n > 0 && <Count n={n} kind="waiting" />}
                    </BoardLink>
                  </li>
                )
              })}
              <li>
                <Link to="/agents/new" className={sideClass(pathname === '/agents/new', true)}>
                  <Plus aria-hidden className="size-4 text-muted-foreground" />
                  <span className="flex-1">New agent</span>
                </Link>
              </li>
            </ul>
          )}
        </nav>
        <div className="mt-auto grid gap-3 pt-6">
          {auth.signedIn ? <AccountMenu collect={collect} /> : <div className="px-1"><AccountControl auth={auth} account={account} full /></div>}
          <div className="grid gap-3 px-2">
            <NetworkSwitch />
            <TestTokens />
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="material-chrome material-edge-bottom sticky top-0 z-30 pt-[var(--safe-top)] lg:hidden">
          <div className="flex min-h-12 items-center justify-between gap-3 pr-[max(1rem,var(--safe-right))] pl-[max(1rem,var(--safe-left))]">
            <Brand />
            {!auth.signedIn && <AccountControl auth={auth} account={account} />}
          </div>
        </header>

        <main key={pathname} className={cn('mx-auto grid min-w-0 w-full animate-[view-in_0.32s_var(--ease-spring)] gap-7 pt-5 pr-[max(1rem,var(--safe-right))] pb-[calc(6.5rem+var(--safe-bottom))] pl-[max(1rem,var(--safe-left))] lg:px-10 lg:pt-10 lg:pb-16', pathname === '/' ? 'max-w-7xl' : 'max-w-3xl')}>
          <LaunchBanner />
          {paused && (
            <div role="alert" className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive-text">
              The contracts are paused by their admin: nothing can be published, delivered, paid or spent until they are unpaused, and deadlines keep running.{' '}
              <a className="underline" href="https://github.com/grmkris/agent-jobs#trust" target="_blank" rel="noreferrer">
                What the admin can do
              </a>
            </div>
          )}
          {children}
          <footer className="mt-4 grid gap-2 text-xs leading-relaxed text-muted-foreground lg:hidden">
            <div className="flex flex-wrap items-center gap-3">
              <NetworkSwitch />
              <TestTokens />
            </div>
          </footer>
        </main>
      </div>

      <nav aria-label="Sections" className="material-chrome fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-border/60 pt-1.5 pr-[var(--safe-right)] pb-[calc(0.375rem+var(--safe-bottom))] pl-[var(--safe-left)] lg:hidden">
        {[jobs, agentsPlace, accountPlace].map((p) => {
          if (p === undefined) return null
          const on = p.active(pathname)
          const Icon = p.icon
          const n = p.label === 'Agents' ? waiting : p.label === 'Account' ? collect : 0
          return (
            <BoardLink key={p.label} target={p.target} aria-current={on ? 'page' : undefined} className={cn('relative grid min-h-11 justify-items-center gap-0.5 py-1 text-micro font-medium transition-opacity active:opacity-60', on ? 'text-foreground' : 'text-muted-foreground')}>
              <Icon aria-hidden className="size-6" strokeWidth={on ? 2.2 : 1.7} />
              {p.label}
              {n > 0 && <Count n={n} kind={p.label === 'Account' ? 'collect' : 'waiting'} className="absolute top-0 left-[calc(50%+0.5rem)]" />}
            </BoardLink>
          )
        })}
      </nav>
    </div>
  )
}

/** Whether this page is the managed agent's own page. */
function onAgent(pathname: string, agentId: string | null): boolean {
  return agentId !== null && new RegExp(`/agent/${agentId}$`).test(pathname)
}

const sideClass = (on: boolean, nested = false) =>
  cn(
    'flex min-h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors duration-(--dur-fast) [@media(hover:hover)]:hover:bg-sidebar-accent/70',
    nested ? 'text-muted-foreground' : 'font-medium',
    on && 'bg-sidebar-accent text-sidebar-accent-foreground [@media(hover:hover)]:hover:bg-sidebar-accent',
  )

function SideItem({ place, on, count = null }: { place: Place; on: boolean; count?: ReactNode }) {
  const Icon = place.icon
  return (
    <BoardLink target={place.target} aria-current={on ? 'page' : undefined} className={sideClass(on)}>
      <Icon aria-hidden className={cn('size-4', on ? 'text-foreground' : 'text-muted-foreground')} />
      <span className="flex-1">{place.label}</span>
      {count}
    </BoardLink>
  )
}
