import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useCollectActions } from '../collect.ts'
import { WalletCard } from '../components/Fund.tsx'
import { InstallHint } from '../components/InstallHint.tsx'
import { PrivyLogin } from '../components/Privy.tsx'
import { Badge, Button, Group, PageTitle, Section, rowClass } from '../components/ui.tsx'
import { useAuth, useSignOut } from '../components/Wallet.tsx'
import { useSponsorStatus } from '../sponsor.ts'
import { useTelegramStatus } from '../telegram.ts'
import { useSafeOwner } from './Admin.tsx'

/**
 * The signed-in person's account: their wallet, what is ready to collect, backing, gas sponsorship, Telegram, admin,
 * and sign out. What waits on them in jobs is under Jobs › Mine; their agents are under Agents.
 */
export function MePage() {
  const auth = useAuth()
  const signOut = useSignOut(auth)
  const owner = useSafeOwner(auth.address)
  const telegram = useTelegramStatus(auth.address, auth.signedIn, false)
  const sponsor = useSponsorStatus(auth.address, auth.signedIn)
  const collect = useCollectActions(auth.address, auth.signedIn).data?.length ?? 0
  if (auth.address === undefined) {
    return (
      <>
        <PageTitle>Account</PageTitle>
        <section className="grid gap-4 rounded-2xl bg-surface p-5 shadow-float">
          <h2 className="text-xl leading-tight font-bold tracking-[-0.02em]">Sign in to post and approve work</h2>
          <p className="leading-relaxed text-label-2">Use your email or Google. Hireling makes you a wallet, so no browser extension is needed; you sign once to prove it is you.</p>
          <div>
            <PrivyLogin />
          </div>
        </section>
        <InstallHint />
      </>
    )
  }
  return (
    <>
      <PageTitle>Account</PageTitle>
      <InstallHint />
      <WalletCard address={auth.address} />
      <Section title="Settings">
        <Group>
          <Link to="/collect" className={rowClass({ interactive: true })}>
            <span className="flex-1">
              Collect
              <span className="block text-xs text-label-3">Payouts, refunds and mining ready for your wallet</span>
            </span>
            {collect > 0 && <span aria-label={`${collect} to collect`}><Badge>{collect}</Badge></span>}
            <ChevronRight aria-hidden className="size-4 text-label-3" />
          </Link>
          <Link to="/stake" className={rowClass({ interactive: true })}>
            <span className="flex-1">
              Stake &amp; delegate
              <span className="block text-xs text-label-3">Your positions, backing and leaving</span>
            </span>
            <ChevronRight aria-hidden className="size-4 text-label-3" />
          </Link>
          <Link to="/sponsorship" className={rowClass({ interactive: true })}>
            <span className="flex-1">
              Gas sponsorship
              <span className="block text-xs text-label-3">Hireling pays the gas for your Hireling transactions</span>
            </span>
            {sponsor.data?.status === 'live' && <Badge tone="success">On</Badge>}
            <ChevronRight aria-hidden className="size-4 text-label-3" />
          </Link>
          <Link to="/telegram" className={rowClass({ interactive: true })}>
            <span className="flex-1">
              Telegram
              <span className="block text-xs text-label-3">A message when a job needs you</span>
            </span>
            {telegram.data?.linked === true && <Badge tone="success">Linked</Badge>}
            <ChevronRight aria-hidden className="size-4 text-label-3" />
          </Link>
          {owner === true && (
            <Link to="/admin" className={rowClass({ interactive: true })}>
              <span className="flex-1">
                Admin
                <span className="block text-xs text-label-3">You own the Safe that owns Hireling</span>
              </span>
              <ChevronRight aria-hidden className="size-4 text-label-3" />
            </Link>
          )}
        </Group>
      </Section>
      <Button variant="danger" size="lg" onClick={signOut}>
        Sign out
      </Button>
    </>
  )
}
