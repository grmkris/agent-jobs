import { describe, expect, it } from 'vitest'
import { retryAction, walletRefused } from './txOperation.ts'

const hash = `0x${'1'.repeat(64)}` as const

describe('wallet step retry reconciliation', () => {
  it('never resends a transaction after a receipt timeout', () => {
    expect(retryAction({ at: 'failed', error: 'RPC unavailable', hash })).toBe('receipt')
  })
  it('only records a confirmed transaction when the board report failed', () => {
    expect(retryAction({ at: 'confirmed', hash, reportError: 'Board unavailable' })).toBe('report')
  })
  it('permits a new send only without a hash or after a proved revert', () => {
    expect(retryAction({ at: 'idle' })).toBe('send')
    expect(retryAction({ at: 'failed', error: 'Wallet declined' })).toBe('send')
    expect(retryAction({ at: 'failed', error: 'Reverted', hash, reverted: true })).toBe('send')
  })
  it('does not act on pending or completed steps', () => {
    expect(retryAction({ at: 'signing' })).toBe('wait')
    expect(retryAction({ at: 'sent', hash })).toBe('wait')
    expect(retryAction({ at: 'confirmed', hash })).toBe('wait')
    expect(retryAction({ at: 'recorded', hash })).toBe('wait')
    expect(retryAction({ at: 'uncertain', error: 'Transport failed after broadcast' })).toBe('wait')
  })
  it('only clears uncertainty after a definitive wallet refusal', () => {
    expect(walletRefused({ cause: { code: 4001 } })).toBe(true)
    expect(walletRefused({ code: 'ACTION_REJECTED' })).toBe(true)
    expect(walletRefused(new Error('Transport failed after broadcast'))).toBe(false)
    expect(walletRefused(new Error('Request cancelled after submission'))).toBe(false)
  })
})
