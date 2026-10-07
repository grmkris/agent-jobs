/**
 * The numbers an agent's profile shows, derived from its record (`/data/agents/<id>`) and its backing: pure functions,
 * so the rules (what counts as settled, which side of the job list opens first, how far the next fee tier is) are
 * tested apart from the page.
 */
import type { MoneyTotals } from './routes/Agent.tsx'
import { tokenMeta } from './format.ts'

/** Below this many settled jobs a percentage says more than the record does: show "2 of 2 paid" instead. */
const RATE_AFTER = 3

export interface Success {
  /** Jobs that ended: paid, or refunded/rejected/not delivered. Open jobs are not counted. */
  settled: number
  paid: number
  /** 0..1 once `settled` reaches RATE_AFTER, else null. */
  rate: number | null
}

/** Success over settled jobs only: an agent with work in flight is not penalised for it. */
export function success(summary: { completed: number; lost: number }): Success {
  const settled = summary.completed + summary.lost
  return { settled, paid: summary.completed, rate: settled >= RATE_AFTER ? summary.completed / settled : null }
}

export interface MoneyLine extends MoneyTotals {
  token: string
}

/** A token's amount as a comparable number (decimals applied); unknown tokens count as 18 decimals. */
const size = (value: string, token: string) => Number(BigInt(value)) / 10 ** (tokenMeta(token)?.decimals ?? 18)

/** Per-token totals, largest gross first; `shown` of them on the tile and how many more sit behind "+N more". */
export function moneyLines(
  totals: Record<string, MoneyTotals> | undefined,
  shown = 2,
): { lines: MoneyLine[]; all: MoneyLine[]; more: number } {
  const all = Object.entries(totals ?? {})
    .filter(([, t]) => BigInt(t.gross) > 0n)
    .map(([token, t]) => ({ token, ...t }))
    .toSorted((a, b) => size(b.gross, b.token) - size(a.gross, a.token))
  return { lines: all.slice(0, shown), all, more: Math.max(0, all.length - shown) }
}

/** Which side of the job list opens first: the one with more jobs, "took" on a tie. */
export const firstSide = (took: number, posted: number): 'took' | 'posted' => (posted > took ? 'posted' : 'took')

/** How far active backing has come from the current fee tier's threshold to the next one; 1 at the lowest fee. */
export function tierProgress(active: bigint, tier: { threshold: bigint; nextThreshold: bigint | null }): number {
  if (tier.nextThreshold === null) return 1
  const span = tier.nextThreshold - tier.threshold
  if (span <= 0n) return 1
  const done = active - tier.threshold
  if (done <= 0n) return 0
  if (done >= span) return 1
  // Four decimal places are plenty for a meter and keep the division in bigint.
  return Number((done * 10_000n) / span) / 10_000
}

/** Whether a record has anything to show yet: a brand-new agent gets the "new on Sidequest" card instead of stats. */
export const isNew = (
  record: { agent: { jobs: number }; hiring?: { posted: number } | undefined } | null | undefined,
) => record === null || record === undefined || (record.agent.jobs === 0 && (record.hiring?.posted ?? 0) === 0)

export type NeedsYouItem =
  | { kind: 'approvals'; count: number }
  | { kind: 'unfinished'; count: number }
  | { kind: 'overdue'; jobIds: string[] }
  | { kind: 'review'; jobIds: string[] }
  | { kind: 'budget'; token: string; left: string; limit: string }
  | { kind: 'revocation' }

/** Below this share of the weekly budget left, the owner hears about it before a hire lands in Approvals. */
const LOW_BUDGET = 0.2

/**
 * What the owner of an agent should act on, most urgent first: decisions waiting, approved operations that did not
 * finish, jobs it took that are past their
 * delivery deadline with nothing delivered, jobs it posted whose submitted work waits on review, a weekly budget nearly
 * spent, a revocation not yet confirmed on-chain. Empty when nothing needs the owner.
 */
export function needsYou(input: {
  pendingApprovals: number
  /** Approved hires or unstakes whose operation did not finish (VV2-032). */
  unfinishedApprovals?: number
  taken: ReadonlyArray<{ job_id: string; status: string; delivery_deadline: number | null }>
  posted: ReadonlyArray<{ job_id: string; status: string }>
  allowances: ReadonlyArray<{ token: string; left: string; limit: string }>
  revoked: boolean
  onchainDisabled: boolean
  now: number
}): NeedsYouItem[] {
  const items: NeedsYouItem[] = []
  if (input.pendingApprovals > 0) items.push({ kind: 'approvals', count: input.pendingApprovals })
  if ((input.unfinishedApprovals ?? 0) > 0) items.push({ kind: 'unfinished', count: input.unfinishedApprovals! })
  const overdue = input.taken
    .filter((j) => j.status === 'active' && j.delivery_deadline !== null && j.delivery_deadline < input.now)
    .map((j) => j.job_id)
  if (overdue.length > 0) items.push({ kind: 'overdue', jobIds: overdue })
  const review = input.posted.filter((j) => j.status === 'submitted').map((j) => j.job_id)
  if (review.length > 0) items.push({ kind: 'review', jobIds: review })
  for (const a of input.allowances) {
    const limit = BigInt(a.limit)
    if (limit > 0n && Number((BigInt(a.left) * 10_000n) / limit) / 10_000 < LOW_BUDGET)
      items.push({ kind: 'budget', token: a.token, left: a.left, limit: a.limit })
  }
  if (input.revoked && !input.onchainDisabled) items.push({ kind: 'revocation' })
  return items
}

/** A day, for "on Sidequest since": "6 Sep", with the year when it is not this year's. */
export function sinceDay(unix: number, now: number): string {
  const date = new Date(unix * 1000)
  const thisYear = date.getFullYear() === new Date(now * 1000).getFullYear()
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(thisYear ? {} : { year: 'numeric' }),
  })
}
