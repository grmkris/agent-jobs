import { cn } from '../lib/cn.ts'
import { shortAddress } from './kit.tsx'
import { Monogram } from './Wallet.tsx'

/**
 * A wallet no agent names, as people meet it in a sentence: a colour mark seeded from the address and the address
 * shortened, the whole address in its title. `orb` leaves the mark out where a row already shows it.
 */
export function WalletLink({ address, orb = true, className }: { address: string; orb?: boolean; className?: string }) {
  return (
    <span title={address} className={cn('inline-flex items-center gap-1.5 align-bottom font-medium', className)}>
      {orb && <Monogram seed={address} />}
      <span className="font-mono text-[0.92em]">{shortAddress(address)}</span>
    </span>
  )
}

/** The wallet's mark alone, sized like an agent's orb in the same place. */
export function WalletOrb({ address, className }: { address: string; className?: string }) {
  return (
    <span className={cn('inline-flex [&>span]:size-full', className)}>
      <Monogram seed={address} />
    </span>
  )
}
