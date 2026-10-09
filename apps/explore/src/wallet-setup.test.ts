import { describe, expect, it } from 'vitest'
import { setupOpen, setupSteps, type SetupFacts } from './wallet-setup.ts'

const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  upgraded: false,
  funded: false,
  sponsored: false,
  ...over,
})

describe('setupSteps', () => {
  it('lists the three steps in order, each to do on a new wallet', () => {
    expect(setupSteps(facts(), new Set())).toEqual([
      { step: 'upgrade', state: 'todo' },
      { step: 'fund', state: 'todo' },
      { step: 'sponsor', state: 'todo' },
    ])
  })

  it('marks steps done from state, skipped by choice, and unknown while loading', () => {
    const steps = setupSteps(facts({ upgraded: true, funded: null, sponsored: false }), new Set(['sponsor']))
    expect(steps.map((s) => s.state)).toEqual(['done', 'unknown', 'skipped'])
  })

  it('drops the upgrade for a wallet that cannot be upgraded here and sponsorship where none is offered', () => {
    const steps = setupSteps(facts({ upgraded: undefined, sponsored: undefined, funded: true }), new Set())
    expect(steps).toEqual([{ step: 'fund', state: 'done' }])
  })

  it('stays open while anything is to do, and closes once every step is done or skipped', () => {
    expect(setupOpen(setupSteps(facts(), new Set()))).toBe(true)
    expect(setupOpen(setupSteps(facts({ upgraded: true, funded: true }), new Set(['sponsor'])))).toBe(false)
  })
})
