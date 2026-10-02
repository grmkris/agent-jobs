import { useQueryClient } from '@tanstack/react-query'
import { Coins, Gem, Hourglass, type LucideIcon, ReceiptText, RotateCcw, Scale } from 'lucide-react'
import { Fragment, useState } from 'react'
import { BoardLink, boardRoutes } from '../components/BoardLink.tsx'
import { SignInToPublish } from '../components/post/SignInToPublish.tsx'
import { useToast } from '../components/Sheet.tsx'
import { TxSteps } from '../components/TxSteps.tsx'
import { Button, EmptyState, Group, ListRow, LoadingRows, PageTitle } from '../components/ui.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { type CollectAction, type CollectKind, useCollectActions } from '../collect.ts'
import { amount } from '../format.ts'

const KIND: Record<CollectKind, { icon: LucideIcon; title: (a: CollectAction) => string; done: string }> = {
  settle: { icon: Scale, title: (a) => `Settle job #${a.jobId ?? '?'}`, done: 'Settled' },
  claimTopUpRefund: { icon: RotateCcw, title: (a) => `Your top-up back from job #${a.jobId ?? '?'}`, done: 'Top-up refunded' },
  withdraw: { icon: Coins, title: () => 'A payment held for you', done: 'Withdrawn to your wallet' },
  claimRefund: { icon: ReceiptText, title: (a) => `Refund from job #${a.jobId ?? '?'}`, done: 'Refunded' },
  stakeWithdraw: { icon: Hourglass, title: () => 'Unstaked FACTORY', done: 'Withdrawn to your wallet' },
  miningClaim: { icon: Gem, title: (a) => `Mining reward${a.epoch == null ? '' : `, epoch ${a.epoch}`}`, done: 'Claimed into your stake' },
}

const keyOf = (a: CollectAction) => `${a.kind}:${a.jobId ?? ''}:${a.epoch ?? ''}:${a.token ?? ''}:${a.transactions.map((t) => t.data).join()}`

/**
 * Collect (U3): everything the signed-in wallet can close or claim, one tap each (the tap opens the wallet, or sends it
 * through Hireling's relay when the wallet's gas sponsorship covers it). Read from the board's `collect_actions`; when
 * the board cannot answer, the page says so rather than guessing an empty list.
 */
export function CollectPage() {
  const auth = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const actions = useCollectActions(auth.address, auth.signedIn)
  const [open, setOpen] = useState<string | null>(null)

  if (auth.address === undefined || !auth.signedIn) {
    return (
      <>
        <PageTitle sub="Payments, refunds and stake you can claim.">Collect</PageTitle>
        <section className="grid gap-4 rounded-2xl bg-surface p-5 shadow-float">
          <h2 className="font-display text-[1.4rem] leading-tight font-bold tracking-[-0.02em]">Sign in to see what you can collect</h2>
          <SignInToPublish auth={auth} label="Sign in" />
        </section>
      </>
    )
  }
  const list = actions.data ?? []
  return (
    <>
      <PageTitle sub="Payments, refunds and stake you can claim, one tap each.">Collect</PageTitle>
      {actions.isLoading ? (
        <LoadingRows rows={3} />
      ) : actions.isError ? (
        <div role="status" className="grid gap-2 rounded-xl bg-warn-bg p-4 text-[0.9rem] text-warn">
          <p>What you can collect cannot be read right now. This does not mean there is nothing waiting for you.</p>
          <Button variant="tinted" onClick={() => void actions.refetch()}>Retry</Button>
        </div>
      ) : list.length === 0 ? (
        <EmptyState title="Nothing to collect">Settlements, refunds, unstaked FACTORY and mining rewards show up here when they are yours to claim.</EmptyState>
      ) : (
        <Group>
          {list.map((a) => {
            const k = KIND[a.kind]
            const Icon = k?.icon ?? Coins
            const key = keyOf(a)
            return (
              // Siblings in the Group, so its hairlines fall between the rows.
              <Fragment key={key}>
                <ListRow inset>
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-tint/14 text-tint">
                    <Icon aria-hidden className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{k?.title(a) ?? a.kind}</span>
                    {a.amount != null && a.token != null && <span className="tabular block font-semibold">{amount(a.amount, a.token)}</span>}
                    <span className="block text-[0.85rem] leading-snug text-label-2">{a.description}</span>
                    {a.jobId != null && (
                      <BoardLink target={boardRoutes().job(a.jobId)} className="text-[0.85rem] text-tint">
                        Open the job
                      </BoardLink>
                    )}
                  </span>
                  {open !== key && (
                    <Button size="sm" className="shrink-0" disabled={open !== null || a.transactions.length === 0} onClick={() => setOpen(key)}>
                      Collect
                    </Button>
                  )}
                </ListRow>
                {open === key && (
                  <div className="px-4 pb-3">
                    <TxSteps
                      taskId={`collect:${key}`}
                      txs={a.transactions}
                      owner={auth.address}
                      reportToBoard={false}
                      autoStart
                      onDone={() => {
                        setOpen(null)
                        void qc.invalidateQueries()
                        toast(k?.done ?? 'Collected')
                      }}
                    />
                  </div>
                )}
              </Fragment>
            )
          })}
        </Group>
      )}
      {list.length > 0 && <p className="px-4 text-[0.8rem] leading-snug text-label-2">The contracts decide who is paid: settling a job pays out as its outcome says and releases both bonds. What is yours comes to your wallet.</p>}
    </>
  )
}
