import { expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { v1FlowArbitrators } from '../scripts/v1-flow-keys.ts'

// Public local-test keys; these are never used by the live runner.
const v1Key = `0x${'11'.repeat(32)}` as const, legacyKey = `0x${'22'.repeat(32)}` as const
const v1 = privateKeyToAccount(v1Key), legacy = privateKeyToAccount(legacyKey)
const config = { hireling: { defaultArbitrator: v1.address }, roles: { arbitrator: legacy.address } }

it('accepts the v1 recipe signer while roles.arbitrator and ARBITRATOR_PRIVATE_KEY remain legacy', () => {
  const selected = v1FlowArbitrators(config, { V1_ARBITRATOR_PRIVATE_KEY: v1Key, ARBITRATOR_PRIVATE_KEY: legacyKey })
  expect(selected.v1.address).toBe(v1.address)
  expect(selected.legacy?.address).toBe(legacy.address)
})

it('refuses the legacy signer as v1 and never prints either key', () => {
  for (const env of [{ V1_ARBITRATOR_PRIVATE_KEY: legacyKey }, { ARBITRATOR_PRIVATE_KEY: legacyKey }]) {
    expect(() => v1FlowArbitrators(config, env)).toThrow('v1 arbitrator key does not match hireling.defaultArbitrator')
  }
})

it('supports the explicit legacy alias and a v1-only environment', () => {
  expect(v1FlowArbitrators(config, { V1_ARBITRATOR_PRIVATE_KEY: v1Key, LEGACY_ARBITRATOR_PRIVATE_KEY: legacyKey }).legacy?.address).toBe(legacy.address)
  expect(v1FlowArbitrators(config, { V1_ARBITRATOR_PRIVATE_KEY: v1Key }).legacy).toBeUndefined()
})

it('permits the old v1 key fallback only if it matches the recipe default', () => {
  expect(v1FlowArbitrators(config, { ARBITRATOR_PRIVATE_KEY: v1Key }).v1.address).toBe(v1.address)
  expect(v1FlowArbitrators({ ...config, hireling: { defaultArbitrator: v1.address.toLowerCase() } }, { V1_ARBITRATOR_PRIVATE_KEY: v1Key }).v1.address).toBe(v1.address)
})

it.each(['missing', 'malformed', 'zero'] as const)('refuses %s configuration or key before any live setup', kind => {
  const record = kind === 'zero' ? { hireling: { defaultArbitrator: `0x${'0'.repeat(40)}` } } : config
  const env = kind === 'missing' ? {} : { V1_ARBITRATOR_PRIVATE_KEY: kind === 'malformed' ? 'private-value' : v1Key }
  expect(() => v1FlowArbitrators(record, env)).toThrow(kind === 'missing' ? 'is not set' : kind === 'malformed' ? 'is invalid' : 'does not match')
})
