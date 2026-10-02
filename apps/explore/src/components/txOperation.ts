import type { Hex } from 'viem'

export type TxStatus =
  | { at: 'idle' }
  | { at: 'signing' }
  | { at: 'uncertain'; error: string; checking?: boolean }
  | { at: 'sent'; hash: Hex }
  | { at: 'confirmed'; hash: Hex; reportError?: string }
  | { at: 'recorded'; hash: Hex }
  | { at: 'failed'; error: string; hash?: Hex; reverted?: boolean }

export function retryAction(status: TxStatus): 'send' | 'receipt' | 'report' | 'wait' {
  if (status.at === 'confirmed' && status.reportError !== undefined) return 'report'
  if (status.at === 'failed' && status.hash !== undefined && status.reverted !== true) return 'receipt'
  if (status.at === 'idle' || status.at === 'failed') return 'send'
  return 'wait'
}

export function walletRefused(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth++) {
    const failure = current as { code?: unknown; cause?: unknown }
    if (failure.code === 4001 || failure.code === 'ACTION_REJECTED') return true
    current = failure.cause
  }
  return false
}

/**
 * The account's next nonce (pending) and the head block, read just before a step goes to the wallet, so an ambiguous
 * wallet error can be settled against the chain instead of guessed. The block is a decimal string (JSON-safe).
 */
export interface SendSnapshot {
  nonce: number
  block: string
}

/** The chain reads a reconciliation needs; the transactions of a block as far as matching a call goes. */
export interface ChainReads {
  nonce(blockTag: 'latest' | 'pending'): Promise<number>
  blockNumber(): Promise<bigint>
  block(number: bigint): Promise<{ transactions: ReadonlyArray<{ hash: Hex; from: string; to: string | null; input: Hex; nonce: number }> }>
}

/**
 * Where a step stands after its wallet failed without a definitive refusal:
 * - `found`: it was mined (the hash to follow);
 * - `not-sent`: every transaction this account sent since the snapshot is accounted for and none is this call, and
 *   nothing is waiting in the mempool, so sending again cannot double it;
 * - `pending`: the account has a transaction waiting that is not mined yet;
 * - `unknown`: the chain could not answer, or there were too many blocks to look through.
 */
export type Reconciled = { at: 'found'; hash: Hex } | { at: 'not-sent' } | { at: 'pending' } | { at: 'unknown' }

const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase()

/**
 * Settles an ambiguous send against the chain. When the account's mined nonce has not moved past the snapshot and
 * nothing is pending, nothing went out. When it has moved, the blocks since the snapshot are read until every one of
 * the account's new transactions is seen; the one carrying this exact call is the step. At most `maxBlocks` blocks are
 * read, after which the answer is `unknown` rather than a guess.
 */
export async function reconcileSend(reads: ChainReads, snapshot: SendSnapshot, from: string, call: { to: string; data: Hex }, maxBlocks = 240): Promise<Reconciled> {
  let mined: number
  let pending: number
  let head: bigint
  try {
    ;[mined, pending, head] = await Promise.all([reads.nonce('latest'), reads.nonce('pending'), reads.blockNumber()])
  } catch {
    return { at: 'unknown' }
  }
  const sent = mined - snapshot.nonce
  if (sent > 0) {
    let seen = 0
    const start = BigInt(snapshot.block)
    const last = head < start + BigInt(maxBlocks) - 1n ? head : start + BigInt(maxBlocks) - 1n
    try {
      for (let n = start; n <= last && seen < sent; n++) {
        for (const tx of (await reads.block(n)).transactions) {
          if (!same(tx.from, from) || tx.nonce < snapshot.nonce) continue
          if (same(tx.to, call.to) && tx.input.toLowerCase() === call.data.toLowerCase()) return { at: 'found', hash: tx.hash }
          seen++
        }
      }
    } catch {
      return { at: 'unknown' }
    }
    if (seen < sent) return { at: 'unknown' }
  }
  return pending > mined ? { at: 'pending' } : { at: 'not-sent' }
}
