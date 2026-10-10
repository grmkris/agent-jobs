import type { Address, Hex } from 'viem'
import { bundleHash, type DisputeBundle } from './arbitration.ts'

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
