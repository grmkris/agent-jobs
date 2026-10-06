import { describe, expect, it } from 'vitest'
import { setupCompletion } from './agent-setup.ts'

describe('confirmed agent setup', () => {
  const now = 1_000
  it('keeps missing and failed facts unknown', () => {
    expect(setupCompletion({ status: undefined, backing: undefined, now })).toEqual({ connected: null, budget: null, backed: null })
  })
  it('operator activity does not prove a client connection', () => {
    const status = { connected: false, last_activity_at: now, allowances: [] }
    expect(setupCompletion({ status, backing: null, now })).toEqual({ connected: false, budget: false, backed: false })
  })
  it('requires a positive unexpired allowance but keeps an exhausted allowance configured', () => {
    for (const allowances of [[], [{ limit: '0', expiresAt: now + 1 }], [{ limit: '1', expiresAt: now }]]) {
      expect(setupCompletion({ status: { connected: true, allowances }, backing: null, now }).budget).toBe(false)
    }
    const status = { connected: true, allowances: [{ limit: '100', left: '0', used: '100', expiresAt: now + 1 }] }
    expect(setupCompletion({ status, backing: { activeShares: 1n }, now })).toEqual({ connected: true, budget: true, backed: true })
  })
  it('requires the operator’s active position', () => {
    for (const backing of [null, { activeShares: 0n }]) {
      expect(setupCompletion({ status: { connected: true, allowances: [] }, backing, now }).backed).toBe(false)
    }
    expect(setupCompletion({ status: { connected: true, allowances: [] }, backing: { activeShares: 2n }, now }).backed).toBe(true)
  })
})
