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
import { Address, Badge, Button, EmptyState, ErrorText, Group, ListRow, LoadingRows, PageTitle, Section } from '../components/ui.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { hireling } from '../hireling.ts'
import { type SponsorPolicy, type SponsorPrep, readDelegation, sponsorApi, sponsorRules, useSponsorStatus } from '../sponsor.ts'
import { friendlyError } from '../txErrors.ts'
import { typedDataArgs } from '../typed-data.ts'
import { chain, deployment, wagmiConfig } from '../wallet.ts'

const SUB = 'Hireling pays the gas for your Hireling transactions.'
const ENDED = { expired: 'Your last permission expired.', used: 'Your last permission is used up.', revoked: 'You turned it off.' } as const

/**
 * Gas sponsorship onboarding (U7, ADR B6): one ERC-7710 delegation from the wallet's EIP-7702 DeleGator to Hireling's
 * relay, limited to Hireling's contracts and methods, a number of calls and an expiry. The relay redeems it to send
 * the wallet's Hireling transactions and pays their gas. Agents sign the same delegation from their own wallet.
 */
export function SponsorshipPage() {
  const auth = useAuth()
  if (hireling === null) {
    return (
      <>
        <PageTitle sub={SUB}>Gas sponsorship</PageTitle>
        <EmptyState title={`Not on ${chain.name} yet`}>It opens with Hireling v1 on this network.</EmptyState>
      </>
    )
  }
  if (auth.address === undefined || !auth.signedIn) {
    return (
      <>
        <PageTitle sub={SUB}>Gas sponsorship</PageTitle>
        <section className="grid gap-4 rounded-2xl bg-surface p-5 shadow-float">
          <h2 className="font-display text-[1.4rem] leading-tight font-bold tracking-[-0.02em]">Sign in to stop paying gas</h2>
          <SignInToPublish auth={auth} label="Sign in" />
        </section>
      </>
    )
  }
  const rules = sponsorRules()
  return rules === null ? null : <Sponsorship wallet={auth.address} rules={rules} />
}

function Sponsorship({ wallet, rules }: { wallet: string; rules: NonNullable<ReturnType<typeof sponsorRules>> }) {
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
        if (upgrade === null) throw new Error('Turn this on from your Hireling email or Google wallet: it points that wallet at the delegation contract first.')
        const hash = await upgrade()
        if (hash !== null) await waitForTransactionReceipt(wagmiConfig, { hash, chainId: chain.id })
      }
      const signature = await signTypedDataAsync(typedDataArgs(p.sign.typedData))
      await sponsorApi.confirm(wallet, signature)
      setPrep(null)
      await refresh()
      toast('Hireling now pays your gas')
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
        <div role="status" className="grid gap-2 rounded-xl bg-warn-bg p-4 text-[0.9rem] text-warn">
          <p>Whether Hireling pays your gas cannot be read right now.</p>
          <Button variant="tinted" onClick={() => void status.refetch()}>Retry</Button>
        </div>
      ) : live !== null ? (
        live.ok ? (
          <>
            <Section title="On" note="The relay sends your Hireling transactions and pays their gas. It can do nothing outside these limits.">
              <Group>
                <ListRow inset>
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ok-bg text-ok">
                    <Fuel aria-hidden className="size-4" />
                  </span>
                  <span className="flex-1 font-medium">Hireling pays your gas</span>
                  <Badge tone="success">On</Badge>
                </ListRow>
                <ListRow>
                  <span className="flex-1">Calls used</span>
                  <span className="tabular text-label-2">
                    {s.callsUsed} of {live.policy.calls.toString()}
                  </span>
                </ListRow>
              </Group>
            </Section>
            <Policy policy={live.policy} />
            <Button variant="danger" busy={busy === 'revoke'} onClick={() => setTurningOff(true)}>
              Turn off
            </Button>
          </>
        ) : (
          <div className="grid gap-2">
            <ErrorText>The permission on file does not read as Hireling’s: {live.problem} Turn it off.</ErrorText>
            <Button variant="danger" busy={busy === 'revoke'} onClick={() => setTurningOff(true)}>
              Turn off
            </Button>
          </div>
        )
      ) : (
        <div className="grid gap-3">
          <Section>
            <Group>
              <ListRow inset>
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-tint/14 text-tint">
                  <Fuel aria-hidden className="size-4" />
                </span>
                <span className="min-w-0 flex-1 text-[0.92rem] leading-snug">
                  You sign one permission. Hireling’s relay then sends your hires, deliveries, approvals and payouts, and pays their gas: only calls to Hireling’s contracts, a limited number of times, until it expires.
                </span>
              </ListRow>
            </Group>
          </Section>
          {s.status !== 'none' && s.status !== 'live' && <p className="px-4 text-[0.88rem] text-label-2">{ENDED[s.status]} Turn it on again for a new one.</p>}
          <Button size="lg" busy={busy === 'prepare'} onClick={() => void begin()}>
            Turn on
          </Button>
          <p className="px-4 text-[0.85rem] leading-snug text-label-2">Agents turn it on the same way, signing the same permission from the agent’s own wallet.</p>
        </div>
      )}
      {error !== null && <ErrorText>{error}</ErrorText>}
      {txs !== null && (
        <Section title="Send from your wallet" note="Disabling the permission on-chain is one transaction from your wallet; the board already stopped using it.">
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
        title="Let Hireling pay your gas?"
        description="You sign this permission for Hireling’s relay. Nothing moves now, and you can turn it off at any time."
        confirm="Sign the permission"
        busy={busy === 'sign'}
        onConfirm={() => void enable()}
      >
        {prep !== null && <Policy policy={prep.policy} />}
        {prep !== null && prep.prep.upgrade !== null && <p className="text-[0.88rem] text-label-2">First your wallet points at the delegation contract. The relay sends that for you.</p>}
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
      <Group>
        <ListRow>
          <span className="flex-1">Relay</span>
          <Address value={deployment.relay} />
        </ListRow>
        {policy.targets.map((t) => (
          <ListRow key={t.address}>
            <span className="flex-1">Call {t.name}</span>
            <Address value={t.address} />
          </ListRow>
        ))}
        <ListRow>
          <span className="shrink-0">Only</span>
          <span className="min-w-0 flex-1 text-right font-mono text-[0.8rem] break-words text-label-2">{policy.methods.map((x) => x.name).join(', ')}</span>
        </ListRow>
        <ListRow>
          <span className="flex-1">At most</span>
          <span className="tabular text-label-2">{policy.calls.toString()} calls</span>
        </ListRow>
        <ListRow>
          <span className="flex-1">Until</span>
          <span className="text-label-2">
            <When at={policy.validUntil} />
          </span>
        </ListRow>
      </Group>
    </Section>
  )
}
