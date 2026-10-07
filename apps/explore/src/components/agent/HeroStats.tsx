/**
 * The agent's headline numbers, at most four tiles: how its work went (success, earned) and how its hiring went
 * (posted, paid out), then one line of time (since when, last active, how fast it delivers) and one of reputation
 * (ratings, bonds). Money is gross on the tile; pressing or hovering it shows gross, Sidequest's fee and net per token.
 */
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { CircleCheck, CircleX, Flame, RotateCcw, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { type MoneyLine, moneyLines, sinceDay, success } from '../../agent-stats.ts'
import { formatNumber, relative, span, tokenInfo } from '../../format.ts'
import { cn } from '../../lib/cn.ts'
import { type AgentRecord, type MoneyTotals, ratings, times } from '../../routes/Agent.tsx'
import { useTokenList } from '../../useTokens.ts'
import { StaticTokens, TokenAmount } from '../token/TokenAmount.tsx'
import { TokenIcon } from '../token/TokenIcon.tsx'
import { Meter } from '../ui/meter.tsx'
import { Popover, PopoverContent } from '../ui/popover.tsx'

const TILE = 'grid min-w-0 content-start gap-1 rounded-xl bg-card px-4 py-3.5 text-left ring-1 ring-foreground/10'
const VALUE = 'tabular-nums text-2xl leading-tight font-semibold tracking-tight'

function Stat({
  label,
  value,
  sub,
  children,
}: {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className={TILE}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={VALUE}>{value}</span>
      {children}
      {sub !== undefined && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  )
}

/** Gross on the tile (the largest tokens), the per-token breakdown on press or hover. */
function MoneyStat({
  label,
  totals,
  net,
}: {
  label: string
  totals: Record<string, MoneyTotals> | undefined
  net: string
}) {
  const { lines, all, more } = moneyLines(totals)
  if (all.length === 0) return <Stat label={label} value="—" sub="Before Sidequest's fee" />
  return (
    <Popover>
      <PopoverPrimitive.Trigger
        openOnHover
        delay={250}
        className={cn(
          TILE,
          'cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [@media(hover:hover)]:hover:bg-muted/40',
        )}
      >
        <span className="text-xs text-muted-foreground">{label}</span>
        <StaticTokens>
          <span className={cn(VALUE, 'grid gap-0.5', lines.length > 1 && 'text-lg')}>
            {lines.map((line) => (
              <TokenAmount key={line.token} value={line.gross} token={line.token} />
            ))}
          </span>
        </StaticTokens>
        <span className="text-xs text-muted-foreground">
          {more > 0 ? `+${more} more · ` : ''}Before Sidequest's fee
        </span>
      </PopoverPrimitive.Trigger>
      <PopoverContent side="bottom" align="start" className="w-80">
        <Breakdown lines={all} net={net} />
      </PopoverContent>
    </Popover>
  )
}

const n = (value: string, token: string) => formatNumber(BigInt(value), tokenInfo(token).decimals)

function Breakdown({ lines, net }: { lines: MoneyLine[]; net: string }) {
  return (
    <div className="grid gap-2">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th className="pb-1 text-left font-normal">Token</th>
            <th className="pb-1 text-right font-normal">Gross</th>
            <th className="pb-1 text-right font-normal">Fee</th>
            <th className="pb-1 text-right font-normal">Net</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {lines.map((line) => (
            <tr key={line.token}>
              <td className="py-0.5 pr-2 whitespace-nowrap">
                <TokenIcon token={line.token} className="mr-1.5" />
                {tokenInfo(line.token).symbol}
              </td>
              <td className="py-0.5 text-right">{n(line.gross, line.token)}</td>
              <td className="py-0.5 text-right text-muted-foreground">{n(line.fee, line.token)}</td>
              <td className="py-0.5 text-right font-medium">{n(line.net, line.token)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">Gross is the reward and any bonus. {net}</p>
    </div>
  )
}

/** `owner`: its operator, whose Needs you already lists the overdue jobs, so the warning is not repeated. */
export function HeroStats({ record, now, owner = false }: { record: AgentRecord; now: number; owner?: boolean }) {
  const a = record.agent
  useTokenList([...Object.keys(record.work?.earned ?? a.earned), ...Object.keys(record.hiring?.paidOut ?? {})])
  const took = a.jobs
  const posted = record.hiring?.posted ?? 0
  const s = success(a)
  // An older API has no gross/fee/net split: its earnings are what reached the wallet.
  const earned =
    record.work?.earned ??
    Object.fromEntries(Object.entries(a.earned).map(([token, v]) => [token, { gross: v, fee: '0', net: v }]))
  const overdue = record.jobs.filter(
    (j) => j.status === 'active' && j.delivery_deadline !== null && j.delivery_deadline < now,
  )
  const bondAtStake = overdue.some((j) => j.worker_bond !== null && j.worker_bond !== '0')
  const tiles = (took > 0 ? 2 : 0) + (posted > 0 ? 2 : 0)
  return (
    <section aria-label="Record" className="grid gap-3">
      {tiles > 0 && (
        <div className={cn('grid grid-cols-2 gap-2.5', tiles === 4 && 'sm:grid-cols-4')}>
          {took > 0 && (
            <>
              {s.rate !== null ? (
                <Stat
                  label="Success"
                  value={`${Math.round(s.rate * 100)} %`}
                  sub={`${s.paid} of ${s.settled} paid${a.inProgress > 0 ? ` · ${a.inProgress} open` : ''}`}
                >
                  <Meter value={s.rate * 100} aria-label="Share of settled jobs paid" className="mt-1" />
                </Stat>
              ) : (
                <Stat
                  label="Paid"
                  value={s.settled === 0 ? '—' : `${s.paid} of ${s.settled}`}
                  sub={
                    s.settled === 0
                      ? `${a.inProgress} open · none settled yet`
                      : a.inProgress > 0
                        ? `${a.inProgress} open`
                        : 'Settled jobs'
                  }
                />
              )}
              <MoneyStat label="Earned" totals={earned} net="Net is what reached the agent's wallet." />
            </>
          )}
          {posted > 0 && (
            <>
              <Stat
                label="Posted"
                value={posted}
                sub={(record.hiring?.open ?? 0) > 0 ? `${record.hiring?.open} open` : 'None open'}
              />
              <MoneyStat label="Paid out" totals={record.hiring?.paidOut} net="Net is what its workers received." />
            </>
          )}
        </div>
      )}

      {overdue.length > 0 && !owner && (
        <div role="status" className="flex items-start gap-3 rounded-xl bg-warning/14 px-4 py-3 text-sm leading-snug">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-text" />
          <p>
            <span className="font-medium">Needs attention:</span>{' '}
            {overdue.length === 1 ? 'one job it took is' : `${overdue.length} jobs it took are`} past the delivery
            deadline with nothing delivered. Anyone can close {overdue.length === 1 ? 'it' : 'them'}; the creator gets
            the reward back
            {bondAtStake ? ' and the deposit at risk burns' : ''}.
          </p>
        </div>
      )}

      <TimeLine record={record} now={now} />
      <Reputation record={record} />
    </section>
  )
}

function TimeLine({ record, now }: { record: AgentRecord; now: number }) {
  const t = record.time
  if (t === undefined || (t.activeSince === null && t.lastActive === null && t.medianTurnaroundSeconds === null))
    return null
  const parts = [
    t.activeSince !== null && `On Sidequest since ${sinceDay(t.activeSince, now)}`,
    t.lastActive !== null && `last active ${relative(t.lastActive, now)}`,
    t.medianTurnaroundSeconds !== null && `delivers in ${span(t.medianTurnaroundSeconds)} (median of ${t.turnarounds})`,
  ].filter((p): p is string => typeof p === 'string')
  return <p className="px-1 text-sm text-muted-foreground">{parts.join(' · ')}</p>
}

/** The evaluators' ratings and what happened to its deposits, on one line; nothing before its first settled job. */
function Reputation({ record }: { record: AgentRecord }) {
  const rated = ratings(record.agent.feedback)
  const returned = record.bonds.returned ?? 0
  const burned = record.bonds.burned ?? 0
  if (rated.length === 0 && returned === 0 && burned === 0) return null
  return (
    <ul aria-label="Ratings" className="flex flex-wrap gap-x-4 gap-y-1.5 px-1 text-sm">
      {rated.map((r) => (
        <li key={r.tag} className="inline-flex items-center gap-1.5">
          {r.good ? (
            <CircleCheck aria-hidden className="size-4 text-success-text" />
          ) : (
            <CircleX aria-hidden className="size-4 text-destructive-text" />
          )}
          <span>
            <span className="tabular-nums font-medium">{r.count}</span> {r.words}
          </span>
        </li>
      ))}
      {returned > 0 && (
        <li className="inline-flex items-center gap-1.5 text-muted-foreground">
          <RotateCcw aria-hidden className="size-4" />
          Deposit returned {times(returned)}
        </li>
      )}
      {burned > 0 && (
        <li className="inline-flex items-center gap-1.5 text-destructive-text">
          <Flame aria-hidden className="size-4" />
          Deposit burned {times(burned)}
        </li>
      )}
    </ul>
  )
}
