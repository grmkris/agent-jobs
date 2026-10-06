import { cn } from '../lib/cn.ts'
import { Button } from '../components/ui/button.tsx'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '../components/ui/empty.tsx'
import { Item, ItemGroup, ItemMedia, ItemContent } from '../components/ui/item.tsx'
import { LoadingRows, PageTitle, textLinkClass } from '../components/kit.tsx'
import { useQueryClient } from '@tanstack/react-query'
import { Coins, Gem, Hourglass, type LucideIcon, ReceiptText, RotateCcw, Scale } from 'lucide-react'
import { Fragment, useState } from 'react'
import { BoardLink, boardRoutes } from '../components/BoardLink.tsx'
import { SignInToPublish } from '../components/post/SignInToPublish.tsx'
import { useToast } from '../components/Sheet.tsx'
import { TxSteps } from '../components/TxSteps.tsx'

import { useAuth } from '../components/Wallet.tsx'
import { type CollectAction, type CollectKind, readMiningClaim, useCollectActions } from '../collect.ts'
import { amount, formatNumber } from '../format.ts'
import { sidequest } from '../sidequest.ts'
import { chain } from '../wallet.ts'

const KIND: Record<CollectKind, { icon: LucideIcon; title: (a: CollectAction) => string; done: string }> = {
  settle: { icon: Scale, title: (a) => `Settle job #${a.jobId ?? '?'}`, done: 'Settled' },
  claimTopUpRefund: { icon: RotateCcw, title: (a) => `Your top-up back from job #${a.jobId ?? '?'}`, done: 'Top-up refunded' },
  withdraw: { icon: Coins, title: () => 'A payment held for you', done: 'Withdrawn to your wallet' },
  claimRefund: { icon: ReceiptText, title: (a) => `Refund from job #${a.jobId ?? '?'}`, done: 'Refunded' },
  stakeWithdraw: { icon: Hourglass, title: () => 'SIDE ready to withdraw', done: 'Withdrawn to your wallet' },
  miningClaim: { icon: Gem, title: (a) => `Mining reward${a.epoch == null ? '' : `, epoch ${a.epoch}`}`, done: 'Claimed into your backing' },
}

const keyOf = (a: CollectAction) =>
  `${a.kind}:${a.jobId ?? ''}:${a.epoch ?? ''}:${a.token ?? ''}:${a.transactions.map((t) => t.data).join()}`

/**
 * Collect (U3): everything the signed-in wallet can close or claim, one tap each (the tap opens the wallet, or sends it
 * through Sidequest's relay when the wallet's gas sponsorship covers it). Read from the board's `collect_actions`; when
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
        <PageTitle sub="Payments, refunds and backing you can claim.">Collect</PageTitle>

        <section className="grid gap-4 rounded-2xl bg-card p-5 shadow-popover">
          <h2 className="text-xl leading-tight font-bold tracking-tight">Sign in to see what you can collect</h2>
          <SignInToPublish auth={auth} label="Sign in" />
        </section>
      </>
    )
  }
  const wallet = auth.address
  const list = actions.data ?? []
  return (
    <>
      <PageTitle sub="Payments, refunds and backing you can claim, one tap each.">Collect</PageTitle>

      {actions.isLoading ? (
        <LoadingRows rows={3} />
      ) : actions.isError ? (
        <div role="status" className="grid gap-2 rounded-xl bg-warning/14 p-4 text-sm text-warning-text">
          <p>What you can collect cannot be read right now. This does not mean there is nothing waiting for you.</p>
          <Button variant="secondary" onClick={() => void actions.refetch()}>
            Retry
          </Button>
        </div>
      ) : list.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing to collect</EmptyTitle>
            <EmptyDescription>
              Settlements, refunds, backing ready to withdraw and mining rewards show up here when they are yours to claim.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup>
          {list.map((a) => {
            const k = KIND[a.kind]
            const Icon = k?.icon ?? Coins
            const key = keyOf(a)
            // A mining claim is read back from its calldata (B8b): offered only as the distributor's claim for this wallet.
            const mining =
              a.kind === 'miningClaim' ? readMiningClaim(a, { chainId: chain.id, distributor: sidequest.distributor, wallet }) : null
            const refused = mining !== null && !mining.ok ? mining.problem : null
            return (
              // Siblings in the Group, so its hairlines fall between the rows.
              <Fragment key={key}>
                <Item className="before:left-14">
                  <ItemMedia>
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/14 text-primary">
                      <Icon aria-hidden className="size-4" />
                    </span>
                  </ItemMedia>
                  <ItemContent className="min-w-0 flex-1">
                    {mining?.ok === true ? (
                      <span className="block font-medium">
                        Mining reward, epoch {String(mining.epoch)} ·{' '}
                        <span className="tabular-nums font-semibold">{formatNumber(mining.amount, 18)} SIDE</span>, backed when collected
                      </span>
                    ) : (
                      <>
                        <span className="block font-medium">{k?.title(a) ?? a.kind}</span>

                        {a.amount != null && a.token != null && (
                          <span className="tabular-nums block font-semibold">{amount(a.amount, a.token)}</span>
                        )}

                        <span className="block text-ui leading-snug text-muted-foreground">{a.description}</span>
                      </>
                    )}
                    {refused !== null && (
                      <span role="alert" className="mt-1 block text-ui leading-snug text-destructive-text">
                        Not offered: {refused}
                      </span>
                    )}
                    {a.jobId != null && (
                      <BoardLink target={boardRoutes().job(a.jobId)} className={cn(textLinkClass, 'text-ui')}>
                        Open the job
                      </BoardLink>
                    )}
                  </ItemContent>
                  {open !== key && (
                    <Button
                      size="sm"
                      className="shrink-0"
                      disabled={open !== null || a.transactions.length === 0 || refused !== null}
                      onClick={() => setOpen(key)}
                    >
                      Collect
                    </Button>
                  )}
                </Item>
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
        </ItemGroup>
      )}

      {list.length > 0 && (
        <p className="px-4 text-ui leading-snug text-muted-foreground">
          The contracts decide who is paid: settling a job pays out as its outcome says and releases both deposits at risk. What is yours comes to your
          wallet.
        </p>
      )}
    </>
  )
}
