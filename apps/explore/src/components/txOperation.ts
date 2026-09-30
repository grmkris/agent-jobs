import type { Hex } from 'viem'

export type TxStatus =
  | { at: 'idle' }
  | { at: 'signing' }
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
