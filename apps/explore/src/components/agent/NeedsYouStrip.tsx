/**
 * The owner's "needs you" list at the top of their agent's Overview: decisions waiting, overdue jobs, work to review,
 * a weekly budget nearly spent, a revocation not yet confirmed. Each item opens where it is handled. Nothing renders
 * when nothing needs the owner.
 */
import { BellDot, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import type { NeedsYouItem } from '../../agent-stats.ts'
import { BoardLink, boardRoutes } from '../BoardLink.tsx'
import { TokenAmount } from '../token/TokenAmount.tsx'

const rowClass =
  'flex min-h-11 w-full items-center gap-3 border-t border-warning/20 px-4 py-2 text-left text-sm transition-colors duration-(--dur-fast) first:border-t-0 hover:bg-warning/10'

function Row({ children, onClick, job }: { children: ReactNode; onClick?: (() => void) | undefined; job?: string | undefined }) {
  const inner = (
    <>
      <span className="min-w-0 flex-1">{children}</span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </>
  )
  if (job !== undefined) return <BoardLink target={boardRoutes().job(job)} className={rowClass}>{inner}</BoardLink>
  return <button type="button" onClick={onClick} className={rowClass}>{inner}</button>
}

const jobs = (ids: string[]) => (ids.length === 1 ? `job #${ids[0]}` : `${ids.length} jobs, newest #${ids[0]}`)

export function NeedsYouStrip({ items, onTab }: { items: NeedsYouItem[]; onTab: (tab: 'approvals' | 'manage') => void }) {
  if (items.length === 0) return null
  return (
    <section aria-label="Needs you" className="overflow-hidden rounded-xl bg-warning/8 ring-1 ring-warning/25">
      <h2 className="flex items-center gap-2 px-4 pt-3 pb-1 text-xs font-medium text-warning-text">
        <BellDot aria-hidden className="size-3.5" />
        Needs you
      </h2>
      {items.map((item) => {
        switch (item.kind) {
          case 'approvals':
            return (
              <Row key="approvals" onClick={() => onTab('approvals')}>
                {item.count === 1 ? 'One decision is' : `${item.count} decisions are`} waiting for you
              </Row>
            )
          case 'unfinished':
            return (
              <Row key="unfinished" onClick={() => onTab('approvals')}>
                {item.count === 1 ? 'One approved operation' : `${item.count} approved operations`} did not finish; continue {item.count === 1 ? 'it' : 'them'}
              </Row>
            )
          case 'overdue':
            return (
              <Row key="overdue" job={item.jobIds[0]}>
                Past its delivery deadline with nothing delivered: {jobs(item.jobIds)}
              </Row>
            )
          case 'review':
            return (
              <Row key="review" job={item.jobIds[0]}>
                Work submitted on {jobs(item.jobIds)} it posted waits for review
              </Row>
            )
          case 'budget':
            return (
              <Row key={`budget-${item.token}`} onClick={() => onTab('manage')}>
                Weekly budget nearly spent: <TokenAmount value={item.left} token={item.token} static /> left
              </Row>
            )
          case 'revocation':
            return (
              <Row key="revocation" onClick={() => onTab('manage')}>
                Revocation is not confirmed on-chain yet
              </Row>
            )
        }
      })}
    </section>
  )
}
