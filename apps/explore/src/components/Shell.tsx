/**
 * The app's frame. On a phone: a translucent top bar (brand and account) and a tab bar at the bottom (Home, Jobs,
 * Workspace, Approvals, Me), both clear of the notch and the home indicator. On a wide screen: a sidebar with the same places,
 * the secondary ones (quotes, boards), the network and the account. Content scrolls under the translucent chrome.
 */
import { Link, useLocation } from '@tanstack/react-router'
import { Bell, Bot, BriefcaseBusiness, CircleUserRound, HandCoins, House, type LucideIcon, MessagesSquare, PlusCircle, SquareStack } from 'lucide-react'
import type { ReactNode } from 'react'
import { currentBoardId } from '../api.ts'
import { isMainnet, usePaused } from '../wallet.ts'
import { type LinkTarget, BoardLink, boardRoutes } from './BoardLink.tsx'
import { LaunchBanner } from './LaunchGate.tsx'
import { NetworkSwitch } from './NetworkSwitch.tsx'
import { cn } from './ui.tsx'
import { useCollectActions } from '../collect.ts'
import { AccountControl, useAuth, useAutoSignIn } from './Wallet.tsx'

interface Place {
  label: string
  icon: LucideIcon
  target: LinkTarget
  /** Whether the current path belongs to this place. */
  active: (path: string) => boolean
}

function places(): { main: Place[]; more: Place[] } {
  const r = boardRoutes()
  const base = r.boardId === 'public' ? '' : `/b/${r.boardId}`
  const under = (p: string) => (path: string) => path.startsWith(`${base}${p}`)
  return {
    main: [
      { label: 'Home', icon: House, target: { to: '/' }, active: (p) => p === '/' },
      { label: 'Jobs', icon: BriefcaseBusiness, target: base === '' ? { to: '/jobs' } : r.jobs(), active: (p) => p === `${base}/jobs` || (base !== '' && (p === base || p === `${base}/`)) || under('/job/')(p) },
      { label: 'Workspace', icon: Bot, target: { to: '/workspace' }, active: (p) => p.startsWith('/workspace') || p.startsWith('/connect') },
      { label: 'Approvals', icon: Bell, target: { to: '/approvals' }, active: (p) => p.startsWith('/approvals') },
      { label: 'Me', icon: CircleUserRound, target: { to: '/me' }, active: (p) => p.startsWith('/me') },
    ],
    more: [
      { label: 'Hire an agent', icon: Bot, target: { to: '/agents' }, active: (p) => p.startsWith('/agents') || p.startsWith('/agent/') || under('/agent/')(p) },
      { label: 'Post a job', icon: PlusCircle, target: r.publish(), active: under('/publish') },
      { label: 'Collect', icon: HandCoins, target: { to: '/collect' }, active: (p) => p.startsWith('/collect') },
      { label: 'Quote requests', icon: MessagesSquare, target: r.quotes(), active: under('/quotes') },
      { label: 'Boards', icon: SquareStack, target: { to: '/boards' }, active: (p) => p.startsWith('/boards') },
    ],
  }
}

/** The brand mark (src/brand/mark.svg), in the tint so it follows light, dark and a tint change. */
function Mark() {
  return (
    <svg aria-hidden viewBox="0 0 32 32" className="size-7 shrink-0">
      <rect width="32" height="32" rx="7" className="fill-tint" />
      <path d="M10 8v16M22 8v16M10 16h12" className="stroke-on-tint" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  )
}

function Brand() {
  const boardId = currentBoardId()
  return (
    <Link to="/" className="flex min-h-11 min-w-0 items-center gap-2.5 font-display text-[1.15rem] font-bold tracking-[-0.02em]">
      <Mark />
      <span className="truncate">
        Hireling
        {boardId !== 'public' && <span className="font-medium text-label-2"> · {boardId}</span>}
      </span>
    </Link>
  )
}

function TestTokens() {
  if (isMainnet) return null
  return (
    <span className="inline-flex items-center gap-1.5 text-[0.75rem] text-label-2">
      <span className="size-1.5 rounded-full bg-warn" />
      Test tokens, no real value
    </span>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const account = useAutoSignIn(auth)
  const paused = usePaused()
  const { pathname } = useLocation()
  const { main, more } = places()
  // Collect is in Me on mobile and in the desktop sidebar; nothing is counted when unknown.
  const collect = useCollectActions(auth.address, auth.signedIn).data?.length ?? 0
  const badge = (label: string) => (label === 'Collect' && collect > 0 ? collect : null)
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-1 overflow-y-auto border-r border-sep bg-side px-3 pt-5 pb-4 lg:flex" aria-label="Sections">
        <div className="px-2.5 pb-5">
          <Brand />
        </div>
        <p className="eyebrow px-3 pb-2 text-[0.6rem]">YOUR NEXT COLLABORATOR</p>
        <nav className="grid gap-0.5">
          {main.map((p) => (
            <SideItem key={p.label} place={p} on={p.active(pathname)} count={badge(p.label)} />
          ))}
        </nav>
        <nav className="mt-4 grid gap-0.5" aria-label="More">
          {more.map((p) => (
            <SideItem key={p.label} place={p} on={p.active(pathname)} quiet count={badge(p.label)} />
          ))}
        </nav>
        <div className="mt-auto grid gap-3 px-2 pt-6">
          <AccountControl auth={auth} account={account} full />
          <NetworkSwitch />
          <TestTokens />
        </div>
      </aside>

      <div className="min-w-0">
        <header className="material sticky top-0 z-30 border-b-[0.5px] border-sep pt-[var(--safe-top)] lg:hidden">
          <div className="flex min-h-12 items-center justify-between gap-3 pr-[max(1rem,var(--safe-right))] pl-[max(1rem,var(--safe-left))]">
            <Brand />
            <AccountControl auth={auth} account={account} />
          </div>
        </header>

        <main key={pathname} className={cn('mx-auto grid min-w-0 w-full animate-[view-in_0.32s_var(--ease-spring)] gap-7 pt-5 pr-[max(1rem,var(--safe-right))] pb-[calc(6.5rem+var(--safe-bottom))] pl-[max(1rem,var(--safe-left))] lg:px-10 lg:pt-10 lg:pb-16', pathname === '/' || pathname.startsWith('/workspace') || pathname.startsWith('/approvals') ? 'max-w-7xl' : 'max-w-3xl')}>
          <LaunchBanner />
          {paused && (
            <div role="alert" className="rounded-xl bg-bad-bg px-4 py-3 text-[0.9rem] text-bad">
              The contracts are paused by their admin: nothing can be published, delivered, paid or spent until they are unpaused, and deadlines keep running.{' '}
              <a className="underline" href="https://github.com/grmkris/agent-jobs#trust" target="_blank" rel="noreferrer">
                What the admin can do
              </a>
            </div>
          )}
          {children}
          <footer className="mt-4 grid gap-2 text-[0.75rem] leading-relaxed text-label-3 lg:hidden">
            <div className="flex flex-wrap items-center gap-3">
              <NetworkSwitch />
              <TestTokens />
            </div>
          </footer>
        </main>
      </div>

      <nav aria-label="Sections" className="material fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t-[0.5px] border-sep pt-1.5 pr-[var(--safe-right)] pb-[calc(0.375rem+var(--safe-bottom))] pl-[var(--safe-left)] lg:hidden">
        {main.map((p) => {
          const on = p.active(pathname)
          const Icon = p.icon
          return (
            <BoardLink key={p.label} target={p.target} className={cn('relative grid justify-items-center gap-0.5 py-1 text-[0.66rem] font-medium active:opacity-60', on ? 'text-tint' : 'text-label-3')}>
              <Icon aria-hidden className="size-6" strokeWidth={on ? 2.2 : 1.8} />
              {p.label}
              {p.label === 'Me' && collect > 0 && <Count n={collect} className="absolute top-0 left-[calc(50%+0.5rem)]" />}
            </BoardLink>
          )
        })}
      </nav>
    </div>
  )
}

/** A small count, as on an app icon: the actions waiting in Collect. */
function Count({ n, className }: { n: number; className?: string }) {
  return (
    <span aria-label={`${n} to collect`} className={cn('tabular grid h-[1.1rem] min-w-[1.1rem] place-items-center rounded-full bg-bad px-1 text-[0.66rem] leading-none font-semibold text-white', className)}>
      {n > 99 ? '99+' : n}
    </span>
  )
}

function SideItem({ place, on, quiet = false, count = null }: { place: Place; on: boolean; quiet?: boolean; count?: number | null }) {
  const Icon = place.icon
  return (
    <BoardLink
      target={place.target}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2 font-medium [@media(hover:hover)]:hover:bg-fill',
        on && 'bg-fill-strong [@media(hover:hover)]:hover:bg-fill-strong',
        quiet && 'text-[0.92rem] text-label-2',
      )}
    >
      <Icon aria-hidden className={cn('size-5', quiet ? 'text-label-3' : 'text-tint')} />
      <span className="flex-1">{place.label}</span>
      {count !== null && <Count n={count} />}
    </BoardLink>
  )
}
