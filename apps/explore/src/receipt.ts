/**
 * A job's receipt, as its card shows it: the money (escrowed, paid to the agent, the fee), its steps with the time
 * between them, and the transaction that paid it. All of it is public chain fact the activity feed already holds.
 */
import type { ChainJob } from './api.ts'
import type { ActivityStep } from './live-activity.ts'

export interface ReceiptLine {
  label: string
  value: string
}

/** Reward, then the agent's share once someone is hired (what it was paid, once paid), then the fee charged. */
export function receiptMoney(
  chain: Pick<ChainJob, 'reward' | 'net' | 'charged_fee'> | undefined,
  paid: boolean,
): ReceiptLine[] {
  if (chain === undefined) return []
  const lines: ReceiptLine[] = []
  if (chain.reward != null) lines.push({ label: 'Reward', value: chain.reward })
  if (chain.net != null) lines.push({ label: paid ? 'Paid to the agent' : "The agent's share", value: chain.net })
  if (chain.charged_fee != null && chain.charged_fee !== '0') lines.push({ label: 'Fee', value: chain.charged_fee })
  return lines
}

const STEP_WORD: Readonly<Record<ActivityStep['step'], string>> = {
  posted: 'posted',
  hired: 'hired',
  delivered: 'delivered',
  completed: 'paid',
  rejected: 'rejected',
  disputed: 'disputed',
  ruled: 'ruled',
  cancelled: 'cancelled',
  expired: 'expired',
}

export interface ReceiptStep {
  word: string
  at: number
  /** Seconds since the step before; null for the first. */
  after: number | null
}

/** The job's steps in order, each with the time since the one before. */
export function receiptTimeline(steps: readonly ActivityStep[]): ReceiptStep[] {
  const timed = steps.flatMap((s) => (s.at === null ? [] : [{ step: s.step, at: s.at }]))
  return timed
    .toSorted((a, b) => a.at - b.at)
    .map((s, i, all) => ({
      word: STEP_WORD[s.step],
      at: s.at,
      after: i === 0 ? null : s.at - (all[i - 1]?.at ?? s.at),
    }))
}

/** The transaction that paid the job, when its paid step is loaded. */
export const paidTx = (steps: readonly ActivityStep[]): string | null =>
  steps.findLast((s) => s.step === 'completed')?.txHash ?? null
