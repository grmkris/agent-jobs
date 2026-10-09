import { cn } from '../lib/cn.ts'
import { Link } from '@tanstack/react-router'
import { useRef } from 'react'
import { Monogram, useAuth } from './Wallet.tsx'
import { WalletPeek } from './WalletPeek.tsx'

/** A small count, as on an app icon. `collect` counts actions ready in Collect; `waiting`, decisions an agent waits on. */
export function Count({ n, kind, className }: { n: number; kind: 'collect' | 'waiting'; className?: string }) {
  return (
    <span
      aria-label={kind === 'collect' ? `${n} to collect` : `${n} waiting`}
      className={cn(
        'tabular-nums grid h-[1.1rem] min-w-[1.1rem] place-items-center rounded-full px-1 text-micro leading-none font-semibold',
        kind === 'collect' ? 'bg-destructive-text text-background' : 'bg-warning/15 text-warning-text',
        className,
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  )
}

/**
 * The signed-in operator's account on a phone, at the header's top right: their mark, a 44 px link to Account, with what
 * is ready to collect counted on it. The phone has no Account tab.
 */
export function AccountAvatar({ collect }: { collect: number }) {
  const auth = useAuth()
  if (auth.address === undefined) return null
  const short = `${auth.address.slice(0, 6)}…${auth.address.slice(-4)}`
  return (
    <Link
      to="/account"
      aria-label={`Account ${short}`}
      className="relative grid size-11 shrink-0 place-items-center rounded-full transition-opacity active:opacity-60"
    >
      <Monogram seed={auth.address} size="md" />
      {collect > 0 && <Count n={collect} kind="collect" className="absolute -top-0.5 -right-1" />}
    </Link>
  )
}

/**
 * The signed-in operator's account row at the foot of the sidebar: the link to Account, where account actions live, and
 * beside it the chevron that opens the wallet's balances.
 */
export function AccountLink({ collect }: { collect: number }) {
  const auth = useAuth()
  const row = useRef<HTMLDivElement>(null)
  if (auth.address === undefined) return null
  const short = `${auth.address.slice(0, 6)}…${auth.address.slice(-4)}`
  return (
    <div ref={row} className="flex min-w-0 items-center gap-0.5">
      <Link
        to="/account"
        aria-label={`Account ${short}`}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors duration-(--dur-fast) hover:bg-sidebar-accent"
      >
        <Monogram seed={auth.address} />
        <span className="min-w-0 flex-1 truncate font-mono text-ui">{short}</span>
        {collect > 0 && <Count n={collect} kind="collect" />}
      </Link>
      <WalletPeek address={auth.address} anchor={row} />
    </div>
  )
}
