import { cn } from '../lib/cn.ts'
import { Link } from '@tanstack/react-router'
import { Monogram, useAuth } from './Wallet.tsx'

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

/** The signed-in operator's account link at the foot of the sidebar. Account actions live on the account destination. */
export function AccountLink({ collect }: { collect: number }) {
  const auth = useAuth()
  if (auth.address === undefined) return null
  const short = `${auth.address.slice(0, 6)}…${auth.address.slice(-4)}`
  return (
    <Link
      to="/account"
      aria-label={`Account ${short}`}
      className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors duration-(--dur-fast) hover:bg-sidebar-accent"
    >
      <Monogram seed={auth.address} />
      <span className="min-w-0 flex-1 truncate font-mono text-ui">{short}</span>
      {collect > 0 && <Count n={collect} kind="collect" />}
    </Link>
  )
}
