import { describe, expect, it } from 'vitest'
import { tapAction } from './preview-tap.ts'

describe('tapAction', () => {
  it('opens the card on a first touch or pen tap, and follows the link otherwise', () => {
    expect(tapAction('touch', false)).toBe('preview')
    expect(tapAction('pen', false)).toBe('preview')
    expect(tapAction('touch', true)).toBe('follow')
    expect(tapAction('mouse', false)).toBe('follow')
    // Enter on a focused link fires no pointer event.
    expect(tapAction(null, false)).toBe('follow')
  })
})
