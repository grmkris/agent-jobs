import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Item, ItemGroup, ItemDescription, ItemContent, ItemActions } from '../components/ui/item.tsx'
import { PageTitle, Section } from '../components/kit.tsx'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useCollectActions } from '../collect.ts'
import { WalletCard } from '../components/Fund.tsx'
import { InstallHint } from '../components/InstallHint.tsx'
import { PrivyLogin } from '../components/Privy.tsx'

import { useAuth, useSignOut } from '../components/Wallet.tsx'
import { useSponsorStatus } from '../sponsor.ts'
import { useTelegramStatus } from '../telegram.ts'
import { useSafeOwner } from './Admin.tsx'

/**
 * The signed-in person's account: their wallet, what is ready to collect, backing, gas sponsorship, Telegram, admin,
 * and sign out. What waits on them in jobs is under Jobs › Mine; their agents are under Agents.
 */
export function AccountPage() {
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

        <section className="grid gap-4 rounded-2xl bg-card p-5 shadow-popover">
          <h2 className="text-xl leading-tight font-bold tracking-tight">Sign in to post and approve work</h2>
          <p className="leading-relaxed text-muted-foreground">
            Use your email or Google. Sidequest makes you a wallet, so no browser extension is needed; you sign once to prove it is you.
          </p>
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
        <ItemGroup>
          <Item render={<Link to="/collect" />}>
            <ItemContent className="flex-1">
              Collect
              <ItemDescription className="block text-xs text-muted-foreground">
                Payouts, refunds and mining ready for your wallet
              </ItemDescription>
            </ItemContent>
            {collect > 0 && (
              <span aria-label={`${collect} to collect`}>
                <Badge variant="neutral">{collect}</Badge>
              </span>
            )}
            <ItemActions>
              <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
          <Item render={<Link to="/backing" />}>
            <ItemContent className="flex-1">
              Back an agent
              <ItemDescription className="block text-xs text-muted-foreground">Your positions, backing and leaving</ItemDescription>
            </ItemContent>
            <ItemActions>
              <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
          <Item render={<Link to="/sponsorship" />}>
            <ItemContent className="flex-1">
              Gas sponsorship
              <ItemDescription className="block text-xs text-muted-foreground">
                Sidequest pays the gas for your Sidequest transactions
              </ItemDescription>
            </ItemContent>
            {sponsor.data?.status === 'live' && <Badge variant="success">On</Badge>}
            <ItemActions>
              <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
          <Item render={<Link to="/telegram" />}>
            <ItemContent className="flex-1">
              Telegram
              <ItemDescription className="block text-xs text-muted-foreground">A message when a job needs you</ItemDescription>
            </ItemContent>
            {telegram.data?.linked === true && <Badge variant="success">Linked</Badge>}
            <ItemActions>
              <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
          {owner === true && (
            <Item render={<Link to="/admin" />}>
              <ItemContent className="flex-1">
                Admin
                <ItemDescription className="block text-xs text-muted-foreground">You own the Safe that owns Sidequest</ItemDescription>
              </ItemContent>
              <ItemActions>
                <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          )}
        </ItemGroup>
      </Section>

      <Button variant="destructive" size="lg" onClick={signOut}>
        Sign out
      </Button>
    </>
  )
}
