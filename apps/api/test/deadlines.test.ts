import { describe, expect, it } from 'vitest'
import { deadlineArgs, resolveDeadline } from '../src/deadlines.ts'

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

describe('deadlineArgs', () => {
  it('echoes the absolute times only when a field was relative or a date', () => {
    const relative = deadlineArgs({ deliveryDeadline: '3d', quoteDeadline: 1_791_100_000, title: 'x' }, ['deliveryDeadline', 'quoteDeadline', 'missing'], now)
    expect(relative.values).toEqual({ deliveryDeadline: now + 259_200, quoteDeadline: 1_791_100_000 })
    expect(relative.echo({ requestId: 'r1' })).toEqual({ requestId: 'r1', deadlines: { deliveryDeadline: now + 259_200, quoteDeadline: 1_791_100_000 } })
    const absolute = deadlineArgs({ deliveryDeadline: 1_791_086_400 }, ['deliveryDeadline'], now)
    expect(absolute.echo({ taskId: 't1' })).toEqual({ taskId: 't1' })
  })
})
