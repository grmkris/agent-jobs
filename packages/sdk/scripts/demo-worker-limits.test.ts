import { describe, expect, it } from 'vitest'
import { type DailyReservations, dailyRemaining, occupiesWorker, reserveDaily } from './demo-worker-limits.ts'

describe('durable UTC daily crew reservations', () => {
  const now = Date.parse('2026-10-05T23:59:59Z')
  it.each([['quotes', 10], ['deliveries', 4]] as const)('bounds %s before an effect and survives a serialized restart', (action, cap) => {
    let saved: DailyReservations = {}
    for (let index = 0; index < cap; index++) saved = reserveDaily(saved, action, String(index), cap, now)!
    const restarted = JSON.parse(JSON.stringify(saved)) as DailyReservations
    expect(reserveDaily(restarted, action, 'extra', cap, now)).toBeUndefined()
    expect(reserveDaily(restarted, action, '0', cap, now)).toBe(restarted)
    expect(dailyRemaining(restarted, action, cap, now)).toBe(0)
    const tomorrow = reserveDaily(restarted, action, 'extra', cap, now + 1000)!
    expect(dailyRemaining(tomorrow, action, cap, now + 1000)).toBe(cap - 1)
    expect(tomorrow['2026-10-05']).toEqual(restarted['2026-10-05'])
  })
  it('charges an operation again if it has to perform an external effect on another UTC day', () => {
    const first = reserveDaily({}, 'deliveries', 'job', 4, now)!
    const next = reserveDaily(first, 'deliveries', 'job', 4, now + 1000)!
    expect(next['2026-10-05']?.deliveries).toEqual(['job'])
    expect(next['2026-10-06']?.deliveries).toEqual(['job'])
  })
  it('retains the single occupied slot through signing, submission, and unresolved penalties', () => {
    for (const phase of ['activating', 'active', 'waiting-checks', 'submitted', 'attention']) expect(occupiesWorker(phase)).toBe(true)
    for (const phase of ['quoted', 'waiting-selection', 'declined', 'completed', 'lost']) expect(occupiesWorker(phase)).toBe(false)
  })
})
