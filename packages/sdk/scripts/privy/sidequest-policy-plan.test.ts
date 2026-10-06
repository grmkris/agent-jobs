import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { authorityPolicy } from './policy.ts'
import { sidequestPolicyPlan } from './sidequest-policy-plan.ts'

const archived = JSON.parse(readFileSync(new URL('../../../../contracts/config/archive/pre-sidequest-monad-testnet.json', import.meta.url), 'utf8'))
const pins = { holding: archived.deployment.main.holding, core: archived.deployment.core, relay: archived.roles.relay }

function fixture() {
  const desired = authorityPolicy('policy-admin')
  const live = { ...structuredClone(desired), id: 'legacy-policy', created_at: 1,
    rules: desired.rules.map((rule, index) => ({ ...structuredClone(rule), id: `rule-${index}` })) }
  live.name = 'Hireling v2 Monad testnet routine signer'
  live.rules[0]!.conditions[1]!.value = pins.holding
  live.rules[1]!.conditions[1]!.value = pins.core
  live.rules[2]!.conditions[1]!.value = pins.core
  live.rules[3]!.conditions[2]!.value = pins.relay
  return { live, desired }
}

describe('separate Sidequest routine policy plan', () => {
  it('preserves the legacy policy and all 11 bounds while planning exactly four fresh pins', () => {
    const { live, desired } = fixture()
    const original = structuredClone(live)
    const plan = sidequestPolicyPlan(live, desired, pins)
    expect(plan.action).toBe('create-separate-policy')
    expect(plan.legacyPolicyId).toBe('legacy-policy')
    expect(plan.legacyPolicyUnchanged).toBe(true)
    expect(plan.changes).toHaveLength(4)
    expect(plan.create).toEqual(desired)
    expect(plan.create.rules).toHaveLength(11)
    expect(plan.create.rules.some(rule => rule.name === 'Deny export' && rule.action === 'DENY')).toBe(true)
    expect(plan.create.rules.some(rule => rule.name === 'Allow TransferWithAuthorization')).toBe(true)
    expect(live).toEqual(original)
    plan.create.rules.pop()
    expect(desired.rules).toHaveLength(11)
  })

  it('compares only the four archived addresses case-insensitively and fingerprints the actual legacy policy', () => {
    const { live, desired } = fixture()
    const first = sidequestPolicyPlan(live, desired, pins)
    live.rules[0]!.conditions[1]!.value = pins.holding.toLowerCase()
    expect(sidequestPolicyPlan(live, desired, pins).create).toEqual(desired)
    live.rules[0]!.conditions[1]!.value = desired.rules[0]!.conditions[1]!.value
    expect(() => sidequestPolicyPlan(live, desired, pins)).toThrow('not the archived deployment')
    expect(first.legacyPolicySha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each([
    ['owner', (live: ReturnType<typeof fixture>['live']) => { live.owner_id = 'other-admin' }],
    ['name', (live: ReturnType<typeof fixture>['live']) => { live.name = 'other-name' }],
    ['network', (live: ReturnType<typeof fixture>['live']) => { live.rules[0]!.conditions[0]!.value = '143' }],
    ['cap', (live: ReturnType<typeof fixture>['live']) => { live.rules[5]!.conditions[3]!.value = '999999999' }],
    ['wallet binding', (live: ReturnType<typeof fixture>['live']) => { live.rules[5]!.conditions[2]!.value = pins.relay }],
    ['action', (live: ReturnType<typeof fixture>['live']) => { live.rules[10]!.action = 'ALLOW' }],
    ['order', (live: ReturnType<typeof fixture>['live']) => { live.rules.reverse() }],
    ['addition', (live: ReturnType<typeof fixture>['live']) => { live.rules.push(structuredClone(live.rules[1]!)) }],
    ['removal', (live: ReturnType<typeof fixture>['live']) => { live.rules.pop() }],
    ['comparison', (live: ReturnType<typeof fixture>['live']) => { live.rules[0]!.conditions[1]!.operator = 'in' }],
  ] as const)('refuses unrelated %s drift', (_name, mutate) => {
    const { live, desired } = fixture()
    mutate(live)
    expect(() => sidequestPolicyPlan(live, desired, pins)).toThrow()
  })

  it('refuses additional policy fields, malformed rules and missing legacy IDs', () => {
    const { live, desired } = fixture()
    expect(() => sidequestPolicyPlan({ ...live, additionalAuthority: true }, desired, pins)).toThrow()
    expect(() => sidequestPolicyPlan({ ...live, rules: [null] }, desired, pins)).toThrow()
    expect(() => sidequestPolicyPlan({ ...live, id: undefined }, desired, pins)).toThrow()
  })

  it('refuses invalid archived addresses and partial reuse of the archived deployment', () => {
    const { live, desired } = fixture()
    expect(() => sidequestPolicyPlan(live, desired, { ...pins, relay: '0x0000000000000000000000000000000000000000' })).toThrow('Invalid deployment pin')
    desired.rules[1]!.conditions[1]!.value = pins.core
    expect(() => sidequestPolicyPlan(live, desired, pins)).toThrow('Expected fresh deployment pins')
  })
})
