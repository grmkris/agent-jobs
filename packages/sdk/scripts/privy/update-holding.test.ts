import { describe, expect, it } from 'vitest'
import { authorityPolicy } from './policy.ts'
import { holdingPolicyUpdate } from './update-holding.ts'

const oldHolding = '0x1111111111111111111111111111111111111111'
const newHolding = '0x2222222222222222222222222222222222222222'

function fixture() {
  const desired = authorityPolicy('policy-admin')
  desired.rules[0]!.conditions[1]!.value = newHolding
  const live = {
    ...structuredClone(desired),
    id: 'policy-id',
    created_at: 1,
    rules: desired.rules.map((rule, index) => ({ ...structuredClone(rule), id: `rule-${index}` })),
  }
  live.rules[0]!.conditions[1]!.value = oldHolding
  return { desired, live }
}

describe('in-place Privy Holding policy diff guard', () => {
  it('permits only the archived-to-promoted contract change and excludes provider metadata from PATCH', () => {
    const { live, desired } = fixture()
    const before = structuredClone(live)
    expect(holdingPolicyUpdate(live, desired, oldHolding)).toEqual({ oldHolding, newHolding, rules: desired.rules })
    expect(live).toEqual(before)
    expect(desired.rules[0]!.conditions[1]!.value).toBe(newHolding)
    expect(desired.rules.every(rule => !('id' in rule))).toBe(true)
  })

  it('compares address case without weakening any other conditions', () => {
    const { live, desired } = fixture()
    const archived = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa'
    live.rules[0]!.conditions[1]!.value = archived.toLowerCase()
    const before = structuredClone(live)
    expect(holdingPolicyUpdate(live, desired, archived).oldHolding).toBe(archived)
    expect(live).toEqual(before)
  })

  it('refuses an unchanged deployment and an already-updated or unrelated live Holding', () => {
    const { live, desired } = fixture()
    expect(() => holdingPolicyUpdate(live, desired, newHolding)).toThrow('Holding has not changed')
    for (const value of [newHolding, '0x3333333333333333333333333333333333333333']) {
      live.rules[0]!.conditions[1]!.value = value
      expect(() => holdingPolicyUpdate(live, desired, oldHolding)).toThrow('not the archived G1b Holding')
    }
  })

  it.each([
    ['owner', (live: ReturnType<typeof fixture>['live']) => { live.owner_id = 'another-admin' }],
    ['chain type', (live: ReturnType<typeof fixture>['live']) => { live.chain_type = 'solana' }],
    ['version', (live: ReturnType<typeof fixture>['live']) => { live.version = '2.0' }],
    ['policy name', (live: ReturnType<typeof fixture>['live']) => { live.name = 'changed' }],
    ['rule name', (live: ReturnType<typeof fixture>['live']) => { live.rules[1]!.name = 'changed' }],
    ['rule method', (live: ReturnType<typeof fixture>['live']) => { live.rules[1]!.method = 'personal_sign' }],
    ['rule action', (live: ReturnType<typeof fixture>['live']) => { live.rules[1]!.action = 'DENY' }],
    ['typed-data chain', (live: ReturnType<typeof fixture>['live']) => { live.rules[0]!.conditions[0]!.value = '143' }],
    ['other contract', (live: ReturnType<typeof fixture>['live']) => { live.rules[1]!.conditions[1]!.value = newHolding }],
    ['relay recipient', (live: ReturnType<typeof fixture>['live']) => { live.rules[3]!.conditions[2]!.value = newHolding }],
    ['rule addition', (live: ReturnType<typeof fixture>['live']) => { live.rules.push(structuredClone(live.rules[1]!)) }],
    ['rule deletion', (live: ReturnType<typeof fixture>['live']) => { live.rules.pop() }],
    ['rule order', (live: ReturnType<typeof fixture>['live']) => { live.rules.reverse() }],
    ['condition deletion', (live: ReturnType<typeof fixture>['live']) => { live.rules[0]!.conditions.pop() }],
    ['condition addition', (live: ReturnType<typeof fixture>['live']) => { live.rules[0]!.conditions.push(structuredClone(live.rules[0]!.conditions[0]!)) }],
  ] as const)('refuses unrelated %s drift', (_name, mutate) => {
    const { live, desired } = fixture()
    mutate(live)
    expect(() => holdingPolicyUpdate(live, desired, oldHolding)).toThrow()
  })

  it('refuses schema mutation, extra policy fields, duplicate Selection rules and malformed rule structures', () => {
    const cases: ((live: Record<string, unknown>) => void)[] = [
      live => { live.unknown_authority = true },
      live => { live.rules = [null] },
      live => { live.rules = [] },
      live => {
        const rules = live.rules as Record<string, unknown>[]
        rules.push(structuredClone(rules[0]!))
      },
      live => {
        const rules = live.rules as { conditions: Record<string, unknown>[] }[]
        rules[0]!.conditions[2]!.typed_data = { primary_type: 'Selection', types: {} }
      },
      live => {
        const rules = live.rules as { conditions: Record<string, unknown>[] }[]
        rules[0]!.conditions[1]!.operator = 'in'
      },
    ]
    for (const mutate of cases) {
      const { live, desired } = fixture()
      mutate(live)
      expect(() => holdingPolicyUpdate(live, desired, oldHolding)).toThrow()
    }
  })

  it.each(['', 'not-an-address', '0x0000000000000000000000000000000000000000'])('refuses invalid archived or promoted address %s', invalid => {
    const { live, desired } = fixture()
    expect(() => holdingPolicyUpdate(live, desired, invalid)).toThrow('Invalid Holding address')
    desired.rules[0]!.conditions[1]!.value = invalid
    expect(() => holdingPolicyUpdate(live, desired, oldHolding)).toThrow('Invalid Holding address')
  })
})
