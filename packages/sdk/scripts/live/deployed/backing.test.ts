import { describe, expect, it } from 'vitest'
import { assertAgentBacking, pendingPublishes } from './backing.ts'

describe('required-bond backing preflight', () => {
  it('reconciles retained intents without demanding a second bond for the same publish', () => {
    const operations = ['a04-concurrent-a', 'a04-concurrent-b']
    expect(pendingPublishes(operations, () => false)).toBe(2)
    expect(pendingPublishes(operations, (key) => key === operations[0])).toBe(1)
    expect(pendingPublishes(operations, () => true)).toBe(0)
  })

  it('reuses the original backing while A03 and A04 bonds are already reserved', () => {
    // 40 SIDE backs four publishes: A03 reserves 10, A04 reserves 20, A07 needs the last 10.
    expect(() => assertAgentBacking(30n, 40n, 40n, 20n)).not.toThrow()
    expect(() => assertAgentBacking(10n, 40n, 40n, 10n)).not.toThrow()
    expect(() => assertAgentBacking(10n, 40n, 40n, 20n)).toThrow('P8_OPERATOR_AGENT_BACKING_REQUIRED')
  })

  it('refuses pooled capital belonging to another backer or queued for withdrawal', () => {
    expect(() => assertAgentBacking(40n, 0n, 40n, 10n)).toThrow('P8_OPERATOR_AGENT_BACKING_REQUIRED')
    expect(() => assertAgentBacking(40n, 30n, 40n, 10n)).toThrow('P8_OPERATOR_AGENT_BACKING_REQUIRED')
  })
})
