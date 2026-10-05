import { useNavigate } from '@tanstack/react-router'
import { ChevronsUpDown, CircleUserRound, HandCoins, Landmark, LogOut, Send, ShieldCheck, Zap } from 'lucide-react'
import { hireling } from '../hireling.ts'
import { useSafeOwner } from '../routes/Admin.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu.tsx'
import { cn } from './ui.tsx'
import { Monogram, useAuth, useSignOut } from './Wallet.tsx'

/** A small count, as on an app icon. `collect` counts actions ready in Collect; `waiting`, decisions an agent waits on. */
export function Count({ n, kind, className }: { n: number; kind: 'collect' | 'waiting'; className?: string }) {
  return (
    <span
      aria-label={kind === 'collect' ? `${n} to collect` : `${n} waiting`}
      className={cn(
        'tabular grid h-[1.1rem] min-w-[1.1rem] place-items-center rounded-full px-1 text-[0.66rem] leading-none font-semibold',
        kind === 'collect' ? 'bg-destructive-text text-background' : 'bg-warning/15 text-warning-text',
        className,
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  )
}

/**
 * The signed-in operator's menu at the foot of the sidebar: the wallet it is, then everything about the account rather
 * than about a job or an agent: Collect (with its count), backing, gas sponsorship, Telegram, admin, sign out.
 */
export function AccountMenu({ collect }: { collect: number }) {
  const auth = useAuth()
  const signOut = useSignOut(auth)
  const navigate = useNavigate()
  if (auth.address === undefined) return null
  const short = `${auth.address.slice(0, 6)}…${auth.address.slice(-4)}`
  const go = (to: string) => void navigate({ to: to as '/' })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account ${short}`}
        className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors duration-(--dur-fast) hover:bg-sidebar-accent data-popup-open:bg-sidebar-accent"
      >
        <Monogram seed={auth.address} />
        <span className="min-w-0 flex-1 truncate font-mono text-ui">{short}</span>
        {collect > 0 && <Count n={collect} kind="collect" />}
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-mono">{short}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => go('/me')}>
            <CircleUserRound />
            Account
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => go('/collect')}>
            <HandCoins />
            <span className="flex-1">Collect</span>
            {collect > 0 && <Count n={collect} kind="collect" />}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => go('/stake')}>
            <Landmark />
            Stake &amp; delegate
          </DropdownMenuItem>
          {hireling !== null && (
            <DropdownMenuItem onClick={() => go('/sponsorship')}>
              <Zap />
              Gas sponsorship
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => go('/telegram')}>
            <Send />
            Telegram
          </DropdownMenuItem>
          <AdminItem address={auth.address} onSelect={() => go('/admin')} />
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={signOut}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Admin, only for an owner of the Safe that owns Hireling; the Safe is read only once the menu opens. */
function AdminItem({ address, onSelect }: { address: string; onSelect: () => void }) {
  const owner = useSafeOwner(address)
  if (owner !== true) return null
  return (
    <DropdownMenuItem onClick={onSelect}>
      <ShieldCheck />
      Admin
    </DropdownMenuItem>
  )
}
