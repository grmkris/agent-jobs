import { expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { v1FlowArbitrators } from '../scripts/v1-flow-keys.ts'

const v1Key = `0x${'11'.repeat(32)}` as const,
  otherKey = `0x${'22'.repeat(32)}` as const
const v1 = privateKeyToAccount(v1Key)
const config = { sidequest: { defaultArbitrator: v1.address } }

it('selects only the dedicated signer that matches the v1 recipe', () => {
  expect(v1FlowArbitrators(config, { V1_ARBITRATOR_PRIVATE_KEY: v1Key }).v1.address).toBe(v1.address)
  expect(
    v1FlowArbitrators(
      { sidequest: { defaultArbitrator: v1.address.toLowerCase() } },
      { V1_ARBITRATOR_PRIVATE_KEY: v1Key },
    ).v1.address,
  ).toBe(v1.address)
  expect(() => v1FlowArbitrators(config, { V1_ARBITRATOR_PRIVATE_KEY: otherKey })).toThrow('does not match')
})
it.each(['missing', 'malformed', 'zero'] as const)('refuses %s configuration or key before setup', (kind) => {
  const record = kind === 'zero' ? { sidequest: { defaultArbitrator: `0x${'0'.repeat(40)}` } } : config
  const env = kind === 'missing' ? {} : { V1_ARBITRATOR_PRIVATE_KEY: kind === 'malformed' ? 'private-value' : v1Key }
  expect(() => v1FlowArbitrators(record, env)).toThrow(
    kind === 'missing' ? 'is not set' : kind === 'malformed' ? 'is invalid' : 'does not match',
  )
})
