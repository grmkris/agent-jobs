import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Item, ItemGroup, ItemDescription, ItemContent, ItemActions } from '../components/ui/item.tsx'
import { PageTitle, Section } from '../components/kit.tsx'
import { Link, useLocation } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { WalletCard } from '../components/Fund.tsx'
import { InstallHint } from '../components/InstallHint.tsx'
import { PrivyLogin } from '../components/Privy.tsx'
import { BackingManager } from '../components/BackingManager.tsx'
import { ResumeOffer } from '../components/post/Resume.tsx'
import { LaunchNotice } from '../components/LaunchGate.tsx'
import { CollectSection } from './Collect.tsx'
import { TelegramSection } from './Telegram.tsx'

import { useAuth, useSignOut } from '../components/Wallet.tsx'
import { useSponsorStatus } from '../sponsor.ts'
import { writesOpen } from '../wallet.ts'
import { useSafeOwner } from './Admin.tsx'

/**
 * The signed-in person's account: wallet, collection, notifications, backing positions, and account settings. What
 * waits on them in jobs is under Jobs › Mine; their agents are under Agents.
 */
export function AccountPage() {
  const auth = useAuth()
  const signOut = useSignOut(auth)
  const owner = useSafeOwner(auth.address)
  const sponsor = useSponsorStatus(auth.address, auth.signedIn)
  const { searchStr } = useLocation()
  const resume = new URLSearchParams(searchStr).get('resume')
  if (auth.address === undefined) {
    return (
      <>
        <PageTitle>Account</PageTitle>

        <section className="grid gap-4 rounded-2xl bg-card p-5 shadow-popover">
          <h2 className="text-xl leading-tight font-bold tracking-tight">Sign in to post and approve work</h2>
          <p className="leading-relaxed text-muted-foreground">
            Use your email or Google. Sidequest makes you a wallet, so no browser extension is needed; you sign once to
            prove it is you.
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

      {resume !== null && resume !== '' && <ResumeOffer key={resume} taskId={resume} auth={auth} />}

      <WalletCard address={auth.address} />

      <CollectSection />

      <TelegramSection />

      <Section id="backing" title="My backing positions">
        {writesOpen ? <BackingManager owner={auth.address} scope={{ kind: 'account' }} /> : <LaunchNotice />}
      </Section>

      <Section title="Settings">
        <ItemGroup>
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
          {owner === true && (
            <Item render={<Link to="/admin" />}>
              <ItemContent className="flex-1">
                Admin
                <ItemDescription className="block text-xs text-muted-foreground">
                  You own the Safe that owns Sidequest
                </ItemDescription>
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
