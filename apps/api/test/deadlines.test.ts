import { describe, expect, it } from 'vitest'
import { deadlineArgs, echoDeadlines, manifestDeadlines, resolveDeadline } from '../src/deadlines.ts'

const now = 1_791_000_000

describe('resolveDeadline', () => {
  it('keeps unix seconds as numbers or digit strings', () => {
    expect(resolveDeadline(1_791_086_400, 'deliveryDeadline', now)).toBe(1_791_086_400)
    expect(resolveDeadline(' 1791086400 ', 'deliveryDeadline', now)).toBe(1_791_086_400)
  })

  it('adds a duration to the clock reading', () => {
    expect(resolveDeadline('30m', 'd', now)).toBe(now + 1800)
    expect(resolveDeadline('2h', 'd', now)).toBe(now + 7200)
    expect(resolveDeadline('3D', 'd', now)).toBe(now + 259_200)
    expect(resolveDeadline('1w', 'd', now)).toBe(now + 604_800)
  })

  it('reads an ISO date only with a zone', () => {
    expect(resolveDeadline('2026-10-13T00:00:00Z', 'd', now)).toBe(Date.UTC(2026, 9, 13) / 1000)
    expect(resolveDeadline('2026-10-13T02:00+02:00', 'd', now)).toBe(Date.UTC(2026, 9, 13) / 1000)
    expect(() => resolveDeadline('2026-10-13T00:00:00', 'd', now)).toThrow(/with a zone/)
  })

  it('refuses anything else as an invalid argument', () => {
    for (const bad of ['', 'soon', '0s', '400d', '-1d', 1.5, 0, -5, null, {}, '3 days']) {
      expect(() => resolveDeadline(bad, 'quoteDeadline', now)).toThrow(expect.objectContaining({ code: 'invalid', message: expect.stringContaining('quoteDeadline') }))
    }
  })
})

describe('deadlineArgs and echoDeadlines', () => {
  it('resolves present fields and marks durations and dates as relative', () => {
    const relative = deadlineArgs({ deliveryDeadline: '3d', quoteDeadline: 1_791_100_000, title: 'x' }, ['deliveryDeadline', 'quoteDeadline', 'missing'], now)
    expect(relative).toEqual({ values: { deliveryDeadline: now + 259_200, quoteDeadline: 1_791_100_000 }, relative: true })
    expect(deadlineArgs({ deliveryDeadline: '1791086400' }, ['deliveryDeadline'], now).relative).toBe(false)
  })

  it('echoes what the board saved, and only for a relative call', () => {
    const saved = { taskId: 't1', manifest: JSON.stringify({ deliveryDeadline: 10, selectionDeadline: null, executionBudget: { expiresAt: 5 } }) }
    expect(echoDeadlines(saved, true, manifestDeadlines)).toEqual({ ...saved, deadlines: { deliveryDeadline: 10, budgetExpiresAt: 5 } })
    expect(echoDeadlines(saved, false, manifestDeadlines)).toBe(saved)
  })
})
