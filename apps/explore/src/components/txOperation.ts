import type { Hex } from 'viem'

export type TxStatus =
  | { at: 'idle' }
  | { at: 'signing' }
  | { at: 'uncertain'; error: string }
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
