import { describe, expect, it } from 'vitest'
import { radioIndex } from './radio.ts'

describe('radio keyboard selection', () => {
  it('wraps Arrow navigation in both directions', () => {
    expect(radioIndex('ArrowRight', 2, 3)).toBe(0)
    expect(radioIndex('ArrowDown', 1, 3)).toBe(2)
    expect(radioIndex('ArrowLeft', 0, 3)).toBe(2)
    expect(radioIndex('ArrowUp', 2, 3)).toBe(1)
  })
  it('supports Home and End without handling Tab or text keys', () => {
    expect(radioIndex('Home', 1, 3)).toBe(0)
    expect(radioIndex('End', 1, 3)).toBe(2)
    expect(radioIndex('Tab', 1, 3)).toBeNull()
    expect(radioIndex('x', 1, 3)).toBeNull()
    expect(radioIndex('ArrowRight', 0, 0)).toBeNull()
  })
})
