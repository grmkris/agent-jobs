import { Badge } from '../components/ui/badge.tsx'
import { Button } from '../components/ui/button.tsx'
import { Item, ItemGroup, ItemMedia, ItemContent, ItemActions } from '../components/ui/item.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Address, LoadingRows, PageTitle, Section } from '../components/kit.tsx'
import { useQueryClient } from '@tanstack/react-query'
import { Fuel } from 'lucide-react'
import { useState } from 'react'
import { useSignTypedData } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import type { TxRequest } from '../api.ts'
import { useDelegatorUpgrade } from '../components/Privy.tsx'
import { SignInToPublish } from '../components/post/SignInToPublish.tsx'
import { ConfirmSheet, useToast } from '../components/Sheet.tsx'
import { When } from '../components/Time.tsx'
import { TxSteps } from '../components/TxSteps.tsx'
import { walletRefused } from '../components/txOperation.ts'

import { useAuth } from '../components/Wallet.tsx'
import {
  type SponsorPolicy,
  type SponsorPrep,
  type SponsorRules,
  readDelegation,
  sponsorApi,
  sponsorRules,
  useSponsorStatus,
} from '../sponsor.ts'
import { friendlyError } from '../txErrors.ts'
import { typedDataArgs } from '../typed-data.ts'
import { chain, deployment, wagmiConfig } from '../wallet.ts'

const SUB = 'Sidequest pays the gas for your Sidequest transactions.'
const ENDED = { expired: 'Your last permission expired.', used: 'Your last permission is used up.', revoked: 'You turned it off.' } as const

/**
 * Gas sponsorship onboarding (U7, ADR B6): one ERC-7710 delegation from the wallet's EIP-7702 DeleGator to Sidequest's
 * relay, limited to Sidequest's contracts and methods, a number of calls and an expiry. The relay redeems it to send
 * the wallet's Sidequest transactions and pays their gas. Agents sign the same delegation from their own wallet.
 */
export function SponsorshipPage() {
  const auth = useAuth()
  if (auth.address === undefined || !auth.signedIn) {
    return (
      <>
        <PageTitle sub={SUB}>Gas sponsorship</PageTitle>

        <section className="grid gap-4 rounded-2xl bg-surface p-5 shadow-float">
          <h2 className="text-xl leading-tight font-bold tracking-[-0.02em]">Sign in to stop paying gas</h2>
          <SignInToPublish auth={auth} label="Sign in" />
        </section>
      </>
    )
  }
  return <Sponsorship wallet={auth.address} rules={sponsorRules()} />
}

function Sponsorship({ wallet, rules }: { wallet: string; rules: SponsorRules }) {
  const qc = useQueryClient()
  const toast = useToast()
  const status = useSponsorStatus(wallet, true)
  const upgrade = useDelegatorUpgrade(wallet)
  const { signTypedDataAsync } = useSignTypedData()
  const [prep, setPrep] = useState<{ prep: SponsorPrep; policy: SponsorPolicy } | null>(null)
  const [busy, setBusy] = useState<'prepare' | 'sign' | 'revoke' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [turningOff, setTurningOff] = useState(false)
  const [txs, setTxs] = useState<TxRequest[] | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['sponsor_status'] })

  const begin = async () => {
    setBusy('prepare')
    setError(null)
    try {
      const p = await sponsorApi.prepare(wallet)
      const read = readDelegation(p.sign.typedData, wallet, rules)
      if (read.ok) setPrep({ prep: p, policy: read.policy })
      else setError(`${read.problem} Nothing was signed.`)
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(null)
    }
  }
  const enable = async () => {
    if (prep === null) return
    const { prep: p } = prep
    setBusy('sign')
    setError(null)
    try {
      if (p.upgrade !== null) {
        if (upgrade === null)
          throw new Error(
            'Turn this on from your Sidequest email or Google wallet: it points that wallet at the delegation contract first.',
          )
        const hash = await upgrade()
        if (hash !== null) await waitForTransactionReceipt(wagmiConfig, { hash, chainId: chain.id })
      }
      const signature = await signTypedDataAsync(typedDataArgs(p.sign.typedData))
      await sponsorApi.confirm(wallet, signature)
      setPrep(null)
      await refresh()
      toast('Sidequest now pays your gas')
    } catch (e) {
      setPrep(null)
      setError(walletRefused(e) ? 'You declined to sign. Nothing changed.' : friendlyError(e))
    } finally {
      setBusy(null)
    }
  }
  const turnOff = async () => {
    setBusy('revoke')
    setError(null)
    try {
      const r = await sponsorApi.revoke(wallet)
      setTurningOff(false)
      if (r.transactions.length > 0) setTxs(r.transactions)
      else {
        await refresh()
        toast('Gas sponsorship off')
      }
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(null)
    }
  }

  const s = status.data
  const live = s?.status === 'live' && s.typedData !== null ? readDelegation(s.typedData, wallet, rules) : null
  return (
    <>
      <PageTitle sub={SUB}>Gas sponsorship</PageTitle>

      {status.isLoading ? (
        <LoadingRows rows={3} />
      ) : status.isError || s === undefined ? (
        <div role="status" className="grid gap-2 rounded-xl bg-warn-bg p-4 text-sm text-warn">
          <p>Whether Sidequest pays your gas cannot be read right now.</p>
          <Button variant="secondary" onClick={() => void status.refetch()}>
            Retry
          </Button>
        </div>
      ) : live !== null ? (
        live.ok ? (
          <>
            <Section
              title="On"
              note="The relay sends your Sidequest transactions and pays their gas. It can do nothing outside these limits."
            >
              <ItemGroup>
                <Item className="before:left-14">
                  <ItemMedia>
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ok-bg text-ok">
                      <Fuel aria-hidden className="size-4" />
                    </span>
                  </ItemMedia>
                  <ItemContent className="flex-1 font-medium">Sidequest pays your gas</ItemContent>
                  <Badge variant="success">On</Badge>
                </Item>
                <Item>
                  <ItemContent className="flex-1">Calls used</ItemContent>
                  <ItemContent className="tabular text-label-2">
                    {s.callsUsed} of {live.policy.calls.toString()}
                  </ItemContent>
                </Item>
              </ItemGroup>
            </Section>

            <Policy policy={live.policy} />

            <Button variant="destructive" busy={busy === 'revoke'} onClick={() => setTurningOff(true)}>
              Turn off
            </Button>
          </>
        ) : (
          <div className="grid gap-2">
            <Alert variant="destructive">
              <AlertDescription>The permission on file does not read as Sidequest’s: {live.problem} Turn it off.</AlertDescription>
            </Alert>
            <Button variant="destructive" busy={busy === 'revoke'} onClick={() => setTurningOff(true)}>
              Turn off
            </Button>
          </div>
        )
      ) : (
        <div className="grid gap-3">
          <Section>
            <ItemGroup>
              <Item className="before:left-14">
                <ItemMedia>
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-tint/14 text-tint">
                    <Fuel aria-hidden className="size-4" />
                  </span>
                </ItemMedia>
                <ItemContent className="min-w-0 flex-1 text-sm leading-snug">
                  You sign one permission. Sidequest’s relay then sends your hires, deliveries, approvals and payouts, and pays their gas:
                  only calls to Sidequest’s contracts, a limited number of times, until it expires.
                </ItemContent>
              </Item>
            </ItemGroup>
          </Section>
          {s.status !== 'none' && s.status !== 'live' && (
            <p className="px-4 text-sm text-label-2">{ENDED[s.status]} Turn it on again for a new one.</p>
          )}
          <Button size="lg" busy={busy === 'prepare'} onClick={() => void begin()}>
            Turn on
          </Button>
          <p className="px-4 text-ui leading-snug text-label-2">
            Agents turn it on the same way, signing the same permission from the agent’s own wallet.
          </p>
        </div>
      )}

      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {txs !== null && (
        <Section
          title="Send from your wallet"
          note="Disabling the permission on-chain is one transaction from your wallet; the board already stopped using it."
        >
          <TxSteps
            taskId={`sponsor-revoke:${wallet.toLowerCase()}`}
            txs={txs}
            owner={wallet}
            reportToBoard={false}
            autoStart
            onDone={() => {
              setTxs(null)
              void refresh()
              toast('Gas sponsorship off')
            }}
          />
        </Section>
      )}

      <ConfirmSheet
        open={prep !== null}
        onClose={() => setPrep(null)}
        title="Let Sidequest pay your gas?"
        description="You sign this permission for Sidequest’s relay. Nothing moves now, and you can turn it off at any time."
        confirm="Sign the permission"
        busy={busy === 'sign'}
        onConfirm={() => void enable()}
      >
        {prep !== null && <Policy policy={prep.policy} />}
        {prep !== null && prep.prep.upgrade !== null && (
          <p className="text-sm text-label-2">First your wallet points at the delegation contract. The relay sends that for you.</p>
        )}
      </ConfirmSheet>

      <ConfirmSheet
        open={turningOff}
        onClose={() => setTurningOff(false)}
        title="Turn off gas sponsorship?"
        description="You pay your own gas again. What the relay already sent stays sent."
        confirm="Turn off"
        tone="destructive"
        busy={busy === 'revoke'}
        onConfirm={() => void turnOff()}
      />
    </>
  )
}

/** The permission's limits, read from its caveats. */
function Policy({ policy }: { policy: SponsorPolicy }) {
  return (
    <Section title="What the relay may do">
      <ItemGroup>
        <Item>
          <ItemContent className="flex-1">Relay</ItemContent>
          <Address value={deployment.relay} />
        </Item>
        {policy.targets.map((t) => (
          <Item key={t.address}>
            <ItemContent className="flex-1">Call {t.name}</ItemContent>
            <Address value={t.address} />
          </Item>
        ))}
        <Item>
          <span className="shrink-0">Only</span>
          <ItemActions className="min-w-0 flex-1 flex-col items-end text-right font-mono text-ui break-words text-label-2">
            {policy.methods.map((x) => x.name).join(', ')}
          </ItemActions>
        </Item>
        <Item>
          <ItemContent className="flex-1">At most</ItemContent>
          <ItemContent className="tabular text-label-2">{policy.calls.toString()} calls</ItemContent>
        </Item>
        <Item>
          <ItemContent className="flex-1">Until</ItemContent>
          <ItemContent className="text-label-2">
            <When at={policy.validUntil} />
          </ItemContent>
        </Item>
      </ItemGroup>
    </Section>
  )
}
