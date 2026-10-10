/**
 * A job's receipt, opened from its title in an activity row: what was delivered (a picture of it, else a glyph), who
 * paid whom, the money, the steps with the time between them, the delivery and the board's check, and the transaction
 * that paid it. Everything here is public: chain facts and the board's recorded deliverable.
 */
import { ArrowRight, Check, CircleAlert, ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { type FeedJob, posterParty } from '../../activity-feed.ts'
import { currentBoardId } from '../../api.ts'
import { type RowDelivery, useRowDelivery } from '../../delivery-preview.ts'
import { previewPlan } from '../../delivery-plan.ts'
import { KIND, checkState, deliveryHref, deliveryWhere } from '../../delivery.ts'
import { span } from '../../format.ts'
import { jobTarget, titleOf } from '../../job-list.ts'
import { cn } from '../../lib/cn.ts'
import { paidTx, receiptMoney, receiptTimeline } from '../../receipt.ts'
import { stage } from '../../wallet.ts'
import { AgentLink } from '../agent/AgentChip.tsx'
import { WalletLink } from '../WalletLink.tsx'
import { BoardLink } from '../BoardLink.tsx'
import { DeliveryPreview } from '../delivery/DeliveryPreview.tsx'
import { TxLink, textLinkClass } from '../kit.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'
import { Skeleton } from '../ui/skeleton.tsx'

/** A label, a dotted leader and a value, like a printed receipt's line. */
function Leader({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <span aria-hidden className="min-w-4 flex-1 translate-y-[-0.2em] border-b border-dotted border-foreground/25" />
      <dd className="shrink-0 font-medium tabular-nums">{children}</dd>
    </div>
  )
}

/** Who paid whom: the poster (its agent, else its wallet), an arrow, the hired agent. */
function Parties({ job }: { job: FeedJob }) {
  const poster = posterParty(job)
  if (job.workerAgent === null && poster === null) return null
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui">
      {poster !== null &&
        ('agent' in poster ? <AgentLink id={poster.agent} orb /> : <WalletLink address={poster.wallet} />)}
      {job.workerAgent !== null && (
        <>
          <span aria-hidden className="flex items-center text-muted-foreground">
            <span className="w-4 border-t border-current" />
            <span className="px-1 text-xs">{job.bucket === 'paid' ? 'paid' : 'hired'}</span>
            <span className="w-3 border-t border-current" />
            <span className="-ml-0.5">▸</span>
          </span>
          <span className="sr-only">{job.bucket === 'paid' ? 'paid' : 'hired'}</span>
          <AgentLink id={job.workerAgent} orb />
        </>
      )}
    </p>
  )
}

function Timeline({ job }: { job: FeedJob }) {
  const steps = receiptTimeline(job.steps)
  if (steps.length === 0) return null
  return (
    <ol className="m-0 flex list-none flex-wrap items-center gap-x-1.5 gap-y-0.5 p-0 font-mono text-[11px] text-muted-foreground">
      {steps.map((s, i) => (
        <li key={`${s.word}-${s.at}`} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>→</span>}
          <span>
            <span className="text-foreground">{s.word}</span>
            {s.after !== null && <span> +{span(s.after)}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

const CHECK = {
  ok: { text: 'Checked at submit', className: 'text-success-text' },
  failed: { text: 'Check at submit failed', className: 'text-destructive-text' },
  unchecked: { text: 'Not checked', className: 'text-muted-foreground' },
} as const

/** Where the delivery lives (a link when it has a web address) and the board's check at submit, a line each. */
function DeliveryLines({ delivery }: { delivery: RowDelivery }) {
  const d = delivery.deliverable.descriptor
  const href = deliveryHref(d)
  const check = checkState(delivery.deliverable.check)
  const where = deliveryWhere(d)
  return (
    <div className="grid gap-1 text-xs">
      <p className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground">{KIND[d.kind]}</span>
        {href === null ? (
          <span className="min-w-0 truncate font-mono">{where}</span>
        ) : (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className={cn(textLinkClass, 'inline-flex min-w-0 items-center gap-1')}
          >
            <span className="truncate font-mono">{where}</span>
            <ExternalLink aria-hidden className="size-3 shrink-0" />
          </a>
        )}
      </p>
      {check !== null && (
        <p className="flex min-w-0 items-center gap-1.5" title={delivery.deliverable.check?.detail}>
          <span className={cn('inline-flex shrink-0 items-center gap-1', CHECK[check].className)}>
            {check === 'ok' ? (
              <Check aria-hidden className="size-3" strokeWidth={3} />
            ) : (
              <CircleAlert aria-hidden className="size-3" />
            )}
            {CHECK[check].text}
          </span>
          <span className="min-w-0 truncate text-muted-foreground">{delivery.deliverable.check?.detail}</span>
        </p>
      )}
    </div>
  )
}

/** The delivery: its picture or glyph on top, its line and check below; a placeholder while it is read. */
function useDelivery(job: FeedJob) {
  const delivered = job.item.chain?.deliverable != null
  const read = useRowDelivery(job, delivered)
  if (!delivered) return { visual: null, line: null }
  if (read.isPending) return { visual: <Skeleton className="aspect-[16/9] w-full rounded-none" />, line: null }
  const delivery = read.data ?? null
  const descriptor = delivery?.deliverable.descriptor ?? null
  const plan = previewPlan({
    jobId: job.item.jobId,
    stage,
    deliverable: descriptor,
    preview: delivery?.preview ?? null,
  })
  return {
    visual: <DeliveryPreview plan={plan} deliverable={descriptor} />,
    line: delivery === null ? null : <DeliveryLines delivery={delivery} />,
  }
}

export function ReceiptCard({ job }: { job: FeedJob }) {
  const chain = job.item.chain
  const paid = job.bucket === 'paid'
  const money = receiptMoney(chain, paid)
  const tx = paidTx(job.steps)
  const delivery = useDelivery(job)
  return (
    <div className="grid">
      {delivery.visual !== null && (
        <div className="overflow-hidden rounded-t-xl border-b border-border/70">{delivery.visual}</div>
      )}
      <div className="grid gap-3 p-3.5">
        <p className="leading-snug font-medium">{titleOf(job.item) || `Job #${job.item.jobId ?? ''}`}</p>
        <Parties job={job} />
        {money.length > 0 && (
          <dl className="m-0 grid gap-1 font-mono text-xs">
            {money.map((line) => (
              <Leader key={line.label} label={line.label}>
                <TokenAmount value={line.value} token={chain?.token} static />
              </Leader>
            ))}
          </dl>
        )}
        <Timeline job={job} />
        {delivery.line}
        <div className="flex items-center justify-between gap-3 border-t border-dashed border-border pt-3">
          {paid ? (
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-block -rotate-6 rounded-sm border-2 border-success-text px-1.5 py-px font-mono text-[11px] font-bold tracking-widest text-success-text',
                  'opacity-90',
                )}
              >
                PAID
              </span>
              <TxLink hash={tx} />
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{job.phase?.label ?? ''}</span>
          )}
          <BoardLink
            target={jobTarget(job.item, currentBoardId())}
            className={cn(textLinkClass, 'inline-flex shrink-0 items-center gap-1 text-ui font-medium')}
          >
            Open the job
            <ArrowRight aria-hidden className="size-4" />
          </BoardLink>
        </div>
      </div>
    </div>
  )
}
