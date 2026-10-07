import { afterEach, expect, test } from 'vitest'
import { context, contextFor } from './client.ts'
import { deployment, setRelayOverride } from './deployment.ts'
import { buildGrant } from './delegation/grants.ts'
import prod from '../../../infra/prod.json' with { type: 'json' }

afterEach(() => setRelayOverride(undefined))
test('stage relay override reaches deployment, every context factory and grant delegate', () => {
  setRelayOverride(prod.relay as `0x${string}`)
  const ctx = context('monad-testnet', 'main', 'http://127.0.0.1:1')
  expect(deployment('monad-testnet').relay).toBe(prod.relay.toLowerCase())
  expect(contextFor('monad-testnet', ctx.stack, 'http://127.0.0.1:1').deployment.relay).toBe(prod.relay.toLowerCase())
  expect(
    buildGrant(ctx, { kind: 'operator', delegator: `0x${'1'.repeat(40)}`, salt: 1n, start: 1800000000 }).delegate,
  ).toBe(prod.relay.toLowerCase())
})
