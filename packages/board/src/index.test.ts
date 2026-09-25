import { describe, expect, it } from 'vitest'
import { ALLOWED_TRANSITIONS, canRelease, canTransition, type TaskStatus } from './index.ts'

describe('board transitions', () => {
  it('lets a reservation lapse back to available but never an assignment', () => {
    expect(canTransition('reserved', 'available')).toBe(true)
    expect(canTransition('assigned', 'available')).toBe(false)
    expect(canTransition('funded', 'available')).toBe(false)
  })

  it('allows release only while reserved', () => {
    const statuses = Object.keys(ALLOWED_TRANSITIONS) as TaskStatus[]
    expect(statuses.filter(canRelease)).toEqual(['reserved'])
  })

  it('reaches settled only through a decision or a dispute', () => {
    expect(canTransition('finalized', 'settled')).toBe(false)
    expect(canTransition('decided', 'settled')).toBe(true)
    expect(canTransition('disputed', 'settled')).toBe(true)
    expect(ALLOWED_TRANSITIONS.settled).toEqual([])
  })
})
