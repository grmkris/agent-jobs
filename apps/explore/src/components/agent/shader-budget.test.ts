import { describe, expect, it } from 'vitest'
import { createShaderBudget } from './shader-budget.ts'

describe('shader budget', () => {
  it('grants up to the limit and hands a released slot to the next one waiting', () => {
    const budget = createShaderBudget(2)
    const granted: string[] = []
    const releases = new Map<string, () => void>()
    const ask = (name: string) => budget.request((release) => { granted.push(name); releases.set(name, release) })
    ask('a'); ask('b')
    const cancelC = ask('c')
    ask('d')
    expect(granted).toEqual(['a', 'b'])
    cancelC()
    releases.get('a')!()
    expect(granted).toEqual(['a', 'b', 'd'])
    expect(budget.used).toBe(2)
  })
  it('releases once, however often a holder lets go', () => {
    const budget = createShaderBudget(1)
    let release: (() => void) | undefined
    const cancel = budget.request((free) => { release = free })
    release?.(); release?.(); cancel()
    expect(budget.used).toBe(0)
  })
})
