import { describe, expect, it } from 'vitest'
import { type Address } from 'viem'
import * as sdk from '../../../src/index.ts'
import { assertGrantPayload } from './signing.ts'

const ctx = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
const operator: Address = '0x1111111111111111111111111111111111111111'
const agent: Address = '0x2222222222222222222222222222222222222222'
const start = Math.floor(Date.now() / 1000)
const allowance = {
  kind: 'allowance' as const,
  delegator: operator,
  agent,
  token: ctx.deployment.rewardTokens[0]!,
  amount: 25_000_000n,
}

function payload(spec: sdk.GrantSpec): string {
  return sdk.delegationTypedData(ctx.deployment, sdk.buildGrant(ctx, spec))
}

describe('Privy fixture signing boundary', () => {
  it('accepts the exact operator, registration, weekly and one-off grants', () => {
    for (const expected of [
      { kind: 'operator' as const, delegator: operator },
      { kind: 'registration' as const, delegator: operator },
      allowance,
      { ...allowance, kind: 'allowance-once' as const },
    ]) {
      expect(assertGrantPayload(ctx, payload({ ...expected, start, salt: 1n }), expected)).toMatch(/^0x[0-9a-f]{64}$/)
    }
  })

  it('refuses a larger amount, different recipient, operator or token', () => {
    for (const changed of [
      { ...allowance, amount: 25_000_001n },
      { ...allowance, agent: operator },
      { ...allowance, delegator: agent },
      { ...allowance, token: ctx.deployment.factory },
    ])
      expect(() => assertGrantPayload(ctx, payload({ ...changed, start, salt: 1n }), allowance)).toThrow()
  })

  it('refuses altered signing domains, caveats, type definitions and expired grants', () => {
    const original = payload({ ...allowance, start, salt: 1n })
    for (const mutate of [
      (data: ReturnType<typeof JSON.parse>) => {
        data.domain.chainId = 143
      },
      (data: ReturnType<typeof JSON.parse>) => {
        data.domain.version = '2'
      },
      (data: ReturnType<typeof JSON.parse>) => {
        data.message.caveats.pop()
      },
      (data: ReturnType<typeof JSON.parse>) => {
        data.types.Delegation[0].type = 'bytes32'
      },
    ]) {
      const data = JSON.parse(original)
      mutate(data)
      expect(() => assertGrantPayload(ctx, JSON.stringify(data), allowance)).toThrow()
    }
    expect(() =>
      assertGrantPayload(
        ctx,
        payload({ ...allowance, start: start - sdk.ALLOWANCE_VALIDITY - 1, salt: 1n }),
        allowance,
      ),
    ).toThrow('P8_SIGNING_TIME_BOUND_CHANGED')
  })
})
