import type { Address, Hex } from 'viem'
import { bundleHash, type DisputeBundle } from './arbitration.ts'
import { getAddress } from 'viem'
import { parseTerms } from './terms.ts'
import type { Sql, TaskRow } from './store.ts'

export interface JobParticipants {
  readonly creator: Address
  readonly approver: Address
  readonly worker: Address | null
  readonly bidders: readonly Address[]
  readonly arbitrator: Address | null
  readonly jobId: string | null
}

/** Read-only board facts: unsigned selections never grant worker access. */
export function participantsOf(sql: Sql, taskId: string): JobParticipants | null {
  const task = sql.all<TaskRow>('SELECT * FROM tasks WHERE id=?', taskId)[0]
  if (task === undefined) return null
  const terms = parseTerms(task.terms_json)
  const selected = sql.all<{ worker: string }>(
    'SELECT worker FROM selections WHERE task_id=? AND signature IS NOT NULL ORDER BY created_at DESC, nonce DESC LIMIT 1',
    taskId,
  )[0]
  const bidders = sql.all<{ worker: string }>(
    `SELECT q.worker FROM quotes q JOIN quote_requests r ON r.id=q.request_id WHERE r.task_id=?
     UNION SELECT worker FROM applications WHERE task_id=?`,
    taskId,
    taskId,
  )
  return {
    creator: getAddress(task.creator),
    approver: terms.approver,
    worker: selected === undefined ? null : getAddress(selected.worker),
    bidders: [...new Set(bidders.map((row) => getAddress(row.worker)))],
    arbitrator: terms.arbitrator ?? null,
    jobId: task.job_id,
  }
}

/** Public conversation is context only; it never changes the frozen dispute evidence. */
export interface DisputeThreadEntry {
  readonly id: number
  readonly author: Address
  readonly roles: readonly string[]
  readonly text: string | null
  readonly hidden: boolean
  readonly replyTo: number | null
  readonly at: number
}

export const MAX_DISPUTE_THREAD = 100
export type DisputeThreadReader = (taskId: string) => Promise<readonly DisputeThreadEntry[]>
export interface DisputeBundleReply {
  readonly bundle: DisputeBundle
  readonly bundleHash: Hex
  readonly thread: readonly DisputeThreadEntry[]
}

export async function withDisputeThread(
  bundle: DisputeBundle,
  reader?: DisputeThreadReader,
): Promise<DisputeBundleReply> {
  const thread = await reader?.(bundle.taskId).catch(() => [])
  return { bundle, bundleHash: bundleHash(bundle), thread: (thread ?? []).slice(-MAX_DISPUTE_THREAD) }
}
