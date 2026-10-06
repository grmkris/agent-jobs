import { cn } from '../lib/cn.ts'
import { PageTitle, textLinkClass } from './kit.tsx'
import type { ReactNode } from 'react'
import { LAUNCH_MESSAGE } from '../launch.ts'
import { NETWORK_ORIGINS, writesOpen } from '../wallet.ts'

const TESTNET = `${NETWORK_ORIGINS['monad-testnet']}/`

/** A page that writes, on mainnet before launch (D16): what it will do, that it opens soon, and where to try it now. */
export function LaunchingSoon({ title }: { title: string }) {
  return (
    <>
      <PageTitle sub="Launching soon">{title}</PageTitle>

      <div role="status" className="grid gap-2 rounded-2xl bg-primary/10 px-4 py-3.5">
        <p className="font-semibold">Sidequest on mainnet opens soon</p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Until launch you can look around, but nothing can be published, taken, staked or paid here. Everything already works on testnet,
          with test tokens.
        </p>
        <a href={TESTNET} className={cn(textLinkClass, 'flex min-h-11 items-center text-sm font-medium')}>
          Try it on testnet
        </a>
      </div>
    </>
  )
}

/** The page's content while writes are open; "launching soon" on mainnet before launch, also when opened by URL. */
export function LaunchGate({ title, children }: { title: string; children: ReactNode }) {
  return writesOpen ? children : <LaunchingSoon title={title} />
}

/** In a page that only reads, where its actions would be: they open at launch. */
export function LaunchNotice() {
  return (
    <p role="status" className="rounded-xl bg-primary/10 px-4 py-3 text-sm leading-snug text-muted-foreground">
      {LAUNCH_MESSAGE}
    </p>
  )
}

/** Over every page on mainnet before launch: reads only, until launch. */
export function LaunchBanner() {
  if (writesOpen) return null
  return (
    <div role="note" className="rounded-xl bg-primary/10 px-4 py-3 text-sm leading-snug text-muted-foreground">
      <span className="font-semibold text-foreground">Launching soon.</span> You can look around; publishing, taking jobs, staking and
      payments open at launch.{' '}
      <a href={TESTNET} className={cn(textLinkClass, 'font-medium')}>
        Try it on testnet
      </a>
    </div>
  )
}
