/**
 * The app's frame. On a phone: a translucent top bar (brand and account) and a tab bar at the bottom (Jobs, Post,
 * Agents, Me), both clear of the notch and the home indicator. On a wide screen: a sidebar with the same places,
 * the secondary ones (quotes, boards), the network and the account. Content scrolls under the translucent chrome.
 */
import { Link, useLocation } from '@tanstack/react-router'
import { Bot, BriefcaseBusiness, CircleUserRound, type LucideIcon, MessagesSquare, PlusCircle, SquareStack } from 'lucide-react'
import type { ReactNode } from 'react'
import { currentBoardId } from '../api.ts'
import { isMainnet, usePaused } from '../wallet.ts'
import { type LinkTarget, BoardLink, boardRoutes } from './BoardLink.tsx'
import { NetworkSwitch } from './NetworkSwitch.tsx'
import { cn } from './ui.tsx'
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
      { label: 'Jobs', icon: BriefcaseBusiness, target: r.jobs(), active: (p) => p === (base || '/') || p === `${base}/` || under('/job/')(p) },
      { label: 'Post', icon: PlusCircle, target: r.publish(), active: under('/publish') },
      { label: 'Agents', icon: Bot, target: { to: '/agents' }, active: (p) => p.startsWith('/agents') || p.startsWith('/agent/') || under('/agent/')(p) || p.startsWith('/connect') },
      { label: 'Me', icon: CircleUserRound, target: { to: '/me' }, active: (p) => p.startsWith('/me') },
    ],
    more: [
      { label: 'Quote requests', icon: MessagesSquare, target: r.quotes(), active: under('/quotes') },
      { label: 'Boards', icon: SquareStack, target: { to: '/boards' }, active: (p) => p.startsWith('/boards') },
    ],
  }
}

function Mark() {
  return (
    <span aria-hidden className="grid size-7 place-items-center rounded-lg bg-tint text-on-tint">
      <BriefcaseBusiness className="size-4" strokeWidth={2.2} />
    </span>
  )
}

function Brand() {
  const boardId = currentBoardId()
  return (
    <Link to="/" className="flex min-w-0 items-center gap-2.5 font-display text-[1.15rem] font-bold tracking-[-0.02em]">
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
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-1 overflow-y-auto border-r border-sep bg-side px-3 pt-5 pb-4 lg:flex" aria-label="Sections">
        <div className="px-2.5 pb-5">
          <Brand />
        </div>
        <nav className="grid gap-0.5">
          {main.map((p) => (
            <SideItem key={p.label} place={p} on={p.active(pathname)} />
          ))}
        </nav>
        <nav className="mt-4 grid gap-0.5" aria-label="More">
          {more.map((p) => (
            <SideItem key={p.label} place={p} on={p.active(pathname)} quiet />
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

        <main key={pathname} className="mx-auto grid w-full max-w-3xl animate-[view-in_0.32s_var(--ease-spring)] gap-6 pt-5 pr-[max(1rem,var(--safe-right))] pb-[calc(6.5rem+var(--safe-bottom))] pl-[max(1rem,var(--safe-left))] lg:px-8 lg:pt-10 lg:pb-16">
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

      <nav aria-label="Sections" className="material fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t-[0.5px] border-sep pt-1.5 pr-[var(--safe-right)] pb-[calc(0.375rem+var(--safe-bottom))] pl-[var(--safe-left)] lg:hidden">
        {main.map((p) => {
          const on = p.active(pathname)
          const Icon = p.icon
          return (
            <BoardLink key={p.label} target={p.target} className={cn('grid justify-items-center gap-0.5 py-1 text-[0.66rem] font-medium active:opacity-60', on ? 'text-tint' : 'text-label-3')}>
              <Icon aria-hidden className="size-6" strokeWidth={on ? 2.2 : 1.8} />
              {p.label}
            </BoardLink>
          )
        })}
      </nav>
    </div>
  )
}

function SideItem({ place, on, quiet = false }: { place: Place; on: boolean; quiet?: boolean }) {
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
      {place.label}
    </BoardLink>
  )
}
