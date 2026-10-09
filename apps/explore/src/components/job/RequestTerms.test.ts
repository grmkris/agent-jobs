import { describe, expect, it } from 'vitest'
import { nextStep } from './RequestTerms.tsx'

describe('request terms', () => {
  const steps = [
    { label: 'Posted', at: 100 },
    { label: 'Quotes close', at: 200 },
    { label: 'Deliver by', at: 300 },
  ]
  it('marks the first date still ahead as next, and none once all have passed', () => {
    expect(nextStep(steps, 50)).toBe(0)
    expect(nextStep(steps, 150)).toBe(1)
    expect(nextStep(steps, 200)).toBe(2)
    expect(nextStep(steps, 400)).toBe(-1)
  })
})
