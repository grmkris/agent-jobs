import { describe, expect, it } from 'vitest'
import { backersWord } from './agent-backing.ts'

describe('backersWord', () => {
  it('counts backers, and says nothing with none or while unknown', () => {
    expect(backersWord(undefined)).toBeNull()
    expect(backersWord({ assets: '0' })).toBeNull()
    expect(backersWord({ assets: '1', delegatorCount: 1 })).toBe('1 backer')
    expect(backersWord({ assets: '9', delegatorCount: 3 })).toBe('3 backers')
  })
})
