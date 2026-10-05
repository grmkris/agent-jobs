import { Link } from '@tanstack/react-router'
import { ChevronRight, Clock, Send } from 'lucide-react'
import { useMemo } from 'react'
import { useCollectActions } from '../collect.ts'
import { BoardLink, boardRoutes } from '../components/BoardLink.tsx'
import { WalletCard } from '../components/Fund.tsx'
import { InstallHint } from '../components/InstallHint.tsx'
import { Sentence, phaseOf } from '../components/Phase.tsx'
import { PrivyLogin } from '../components/Privy.tsx'
import { useNow } from '../components/Time.tsx'
import { Badge, Button, EmptyState, ErrorText, Group, LoadingRows, PageTitle, Section, rowClass } from '../components/ui.tsx'
import { useAuth, useSignOut } from '../components/Wallet.tsx'
import { hireling } from '../hireling.ts'
import { useSponsorStatus } from '../sponsor.ts'
import { useTelegramStatus } from '../telegram.ts'
import { useSafeOwner } from './Admin.tsx'
import { useJobs } from './Jobs.tsx'

/** The signed-in person's place: what needs them now (from the shared lifecycle model), their wallet, sign out. */
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
        <PageTitle>Me</PageTitle>
        <section className="grid gap-4 rounded-2xl bg-surface p-5 shadow-float">
          <h2 className="font-display text-[1.4rem] leading-tight font-bold tracking-[-0.02em]">Sign in to post and approve work</h2>
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
      <PageTitle>Me</PageTitle>
      <InstallHint />
      <NeedsYou address={auth.address} />
      <WalletCard address={auth.address} />
      <Section title="More">
        <Group>
          <Link to="/stake" className={rowClass({ interactive: true })}>
            <span className="flex-1">
              Stake &amp; delegate
              <span className="block text-[0.78rem] text-label-3">Your positions, backing and leaving</span>
            </span>
            <ChevronRight aria-hidden className="size-4 text-label-3" />
          </Link>
          <Link to="/collect" className={rowClass({ interactive: true })}>
            <span className="flex-1">
              Collect
              <span className="block text-[0.78rem] text-label-3">Payouts, refunds and mining ready for your wallet</span>
            </span>
            {collect > 0 && <span aria-label={`${collect} to collect`}><Badge>{collect}</Badge></span>}
            <ChevronRight aria-hidden className="size-4 text-label-3" />
          </Link>
          {hireling !== null && (
            <Link to="/sponsorship" className={rowClass({ interactive: true })}>
              <span className="flex-1">
                Gas sponsorship
                <span className="block text-[0.78rem] text-label-3">Hireling pays the gas for your Hireling transactions</span>
              </span>
              {sponsor.data?.status === 'live' && <Badge tone="success">On</Badge>}
              <ChevronRight aria-hidden className="size-4 text-label-3" />
            </Link>
          )}
          <Link to="/telegram" className={rowClass({ interactive: true })}>
            <span className="flex-1">
              Telegram
              <span className="block text-[0.78rem] text-label-3">A message when a job needs you</span>
            </span>
            {telegram.data?.linked === true && <Badge tone="success">Linked</Badge>}
            <ChevronRight aria-hidden className="size-4 text-label-3" />
          </Link>
          {owner === true && (
            <Link to="/admin" className={rowClass({ interactive: true })}>
              <span className="flex-1">
                Admin
                <span className="block text-[0.78rem] text-label-3">You own the Safe that owns Hireling</span>
              </span>
              <ChevronRight aria-hidden className="size-4 text-label-3" />
            </Link>
          )}
          <Link to="/boards" className={rowClass({ interactive: true })}>
            <span className="flex-1">Boards</span>
            <ChevronRight aria-hidden className="size-4 text-label-3" />
          </Link>
          <BoardLink target={boardRoutes().quotes()} className={rowClass({ interactive: true })}>
            <span className="flex-1">Quote requests</span>
            <ChevronRight aria-hidden className="size-4 text-label-3" />
          </BoardLink>
        </Group>
      </Section>
      <Button variant="danger" size="lg" onClick={signOut}>
        Sign out
      </Button>
    </>
  )
}

function NeedsYou({ address }: { address: string }) {
  const { items, loading, chainUnavailable, chainError, refetch } = useJobs()
  const now = useNow()
  // Recomputed each minute, not each second: the list only changes when a deadline passes.
  const minute = Math.floor(now / 60)
  const mine = useMemo(
    () =>
      items
        .map((i) => ({ item: i, phase: phaseOf(i.chain, i.task, address, minute * 60) }))
        .filter((x) => x.phase !== null && x.phase.youAct && x.phase.toYou !== null)
        .toSorted((a, b) => (a.phase?.deadline ?? Infinity) - (b.phase?.deadline ?? Infinity)),
    [items, address, minute],
  )
  return (
    <Section title={loading || chainUnavailable ? 'Needs you' : `Needs you · ${mine.length}`} note="From chain facts; a job's page shows exact review and dispute deadlines.">
      {chainError !== null && <ErrorText>Chain data is unavailable. {chainUnavailable ? 'Actions and counts cannot be confirmed.' : 'Showing last-known actions.'} <Button variant="tinted" onClick={() => void refetch()}>Retry</Button></ErrorText>}
      {chainUnavailable ? (
        <EmptyState title="Chain status unavailable">Retry before deciding whether a job needs you.</EmptyState>
      ) : loading ? (
        <LoadingRows rows={2} />
      ) : mine.length === 0 ? (
        <EmptyState title="Nothing needs you right now">Approvals, selections and refunds you can claim show up here.</EmptyState>
      ) : (
        <Group>
          {mine.map(({ item, phase }) => {
            const target = item.jobId === null ? { ...boardRoutes().publish(), search: { resume: item.task?.taskId ?? '' } } : boardRoutes().job(item.jobId)
            return (
              <BoardLink key={item.jobId ?? item.task?.taskId} target={target} className={rowClass({ inset: true, interactive: true })}>
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-warn-bg text-warn">
                    {item.jobId === null ? <Send aria-hidden className="size-4" /> : <Clock aria-hidden className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.task?.title ?? `Job #${item.jobId}`}</span>
                    <span className="block text-[0.86rem] leading-snug text-label-2">{phase !== null && phase.toYou !== null && <Sentence parts={phase.toYou} />}</span>
                  </span>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-label-3" />
              </BoardLink>
            )
          })}
        </Group>
      )}
    </Section>
  )
}
