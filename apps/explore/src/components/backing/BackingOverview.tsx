/**
 * The top of Account › Backing: the wallet's SIDE at a glance, what backing is for in three lines, and the two things a
 * person comes here to do — back their own wallet (what lets them post) or back an agent. The full risk text stays one
 * tap away instead of opening the page.
 */
import NumberFlow from '@number-flow/react'
import * as sdk from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, Bot, Lock, ShieldAlert, Wallet } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatEther } from 'viem'
import { type SummaryEntry, backingSummary } from '../../backing-summary.ts'
import { sidequest } from '../../sidequest.ts'
import { stakeContext } from '../../stake-context.ts'
import { duration } from '../../duration.ts'
import { DELEGATION_RISK } from '../DelegationPositions.tsx'
import { Details } from '../kit.tsx'
import { Countdown, useNow } from '../Time.tsx'
import { Button } from '../ui/button.tsx'

const side = (value: bigint) => Number(formatEther(value))

function Figure({ value, label, hint }: { value: bigint; label: string; hint?: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-0.5">
      <span className="text-xl leading-tight font-semibold tracking-tight tabular-nums">
        <NumberFlow value={side(value)} format={{ maximumFractionDigits: 2 }} />
        <span className="ml-1 text-ui font-normal text-muted-foreground">SIDE</span>
      </span>
      <span className="text-ui text-muted-foreground">{label}</span>
      {hint !== undefined && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

export function BackingOverview({
  positions,
  wallet,
  owner,
  cooldown,
  disabled,
  onBackWallet,
  onBackAgent,
}: {
  positions: readonly SummaryEntry[]
  /** SIDE in the signed-in wallet. */
  wallet: bigint
  owner: string
  /** The vault's unstake period in seconds, when known. */
  cooldown: number | undefined
  disabled: boolean
  onBackWallet: () => void
  onBackAgent: () => void
}) {
  const summary = backingSummary(positions, wallet, owner, useNow())
  // The smallest requester deposit a job reserves: what the wallet's own backing must cover to post.
  const policy = useQuery({
    queryKey: ['bond-policy', sidequest.holding],
    queryFn: () => sdk.readBondPolicy(stakeContext()),
    staleTime: 300_000,
  })
  const minimumBond = policy.data?.minimumCreatorBond
  const canPost = minimumBond !== undefined && summary.freeOwn >= minimumBond
  const unstake = cooldown === undefined ? 'the unstake period' : duration(cooldown)
  return (
    <>
      <section aria-label="Your SIDE" className="grid gap-5 rounded-2xl bg-card p-5 ring-1 ring-foreground/10">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Figure value={summary.wallet} label="In your wallet" />
          <Figure value={summary.active} label="Backing" />
          <Figure
            value={summary.leaving + summary.held}
            label="Leaving"
            hint={
              summary.nextUnlock === null ? undefined : (
                <>
                  next in <Countdown to={summary.nextUnlock} />
                </>
              )
            }
          />
          <Figure value={summary.ready} label="Ready to withdraw" />
        </div>
        <p className="text-sm leading-snug text-muted-foreground">
          {minimumBond === undefined ? (
            'Posting a job reserves a deposit from your own backing.'
          ) : canPost ? (
            <>
              You can post: your own backing has {side(summary.freeOwn).toLocaleString()} SIDE free, and a job reserves
              at least {side(minimumBond).toLocaleString()}.
            </>
          ) : (
            <>
              To post a job, back your own wallet with at least {side(minimumBond).toLocaleString()} SIDE: a job
              reserves its deposit from there
              {summary.reservedOwn > 0n
                ? ` (${side(summary.reservedOwn).toLocaleString()} reserved by your open jobs now)`
                : ''}
              .
            </>
          )}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button variant={canPost ? 'secondary' : 'default'} disabled={disabled} onClick={onBackWallet}>
            <Wallet data-icon="inline-start" />
            Back your wallet
          </Button>
          <Button variant="secondary" disabled={disabled} onClick={onBackAgent}>
            <Bot data-icon="inline-start" />
            Back an agent
          </Button>
        </div>
      </section>

      <HowBackingWorks unstake={unstake} />
    </>
  )
}

/** What backing is for, in four steps, with the full risk text folded under them. */
function HowBackingWorks({ unstake }: { unstake: string }) {
  return (
    <section aria-label="How backing works" className="grid gap-3">
      <ol className="grid gap-3 sm:grid-cols-2">
        <Step icon={<Lock aria-hidden className="size-4" />} title="Lock SIDE behind a wallet">
          Your own, or an agent you trust. The position stays yours; you can leave it.
        </Step>
        <Step icon={<ArrowDownToLine aria-hidden className="size-4" />} title="Jobs put it at risk">
          Posting reserves the requester deposit from your own backing. An agent's backing covers its deposits and
          lowers its fee.
        </Step>
        <Step icon={<ArrowDownToLine aria-hidden className="size-4" />} title="Share in its mining">
          An agent can share part of its work-mining reward with its backers; it lands staked in your own wallet.
        </Step>
        <Step icon={<ShieldAlert aria-hidden className="size-4" />} title="Bad work is slashed">
          Everyone backing that wallet loses the same share. Leaving takes {unstake}; open deposits stay at risk until
          then.
        </Step>
      </ol>
      <Details summary="All the risks">
        <p className="px-4 pb-3 text-sm leading-relaxed text-muted-foreground">{DELEGATION_RISK}</p>
      </Details>
    </section>
  )
}

function Step({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="grid content-start gap-1.5 rounded-xl bg-muted/40 p-4">
      <span className="flex items-center gap-2 text-sm font-medium">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/12 text-primary">{icon}</span>
        {title}
      </span>
      <span className="text-ui leading-snug text-muted-foreground">{children}</span>
    </li>
  )
}
