import { toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { ApiError, type TxRequest } from './api.ts'
import { type SponsorPolicy, SPONSOR_BATCH, sponsorKey, sponsorable, submitFailure } from './sponsor.ts'

const holding = '0x00000000000000000000000000000000000000d1'
const token = '0x00000000000000000000000000000000000000e1'
const settle = toFunctionSelector('function settle(uint256 jobId)')
const policy: SponsorPolicy = {
  targets: [{ address: holding, name: 'Holding' }],
  methods: [{ selector: settle, name: 'settle' }],
  calls: 5n,
  validUntil: 2_000_000_000,
}
const live = { policy, callsUsed: 0 }
const tx = (over: Partial<TxRequest> = {}): TxRequest => ({
  description: 'Settle job #1',
  chainId: 10143,
  to: holding,
  data: `${settle}${'0'.repeat(63)}1`,
  value: '0',
  ...over,
})

describe('which steps the relay sends', () => {
  it('sends calls the signed delegation allows, while it has calls left', () => {
    expect(sponsorable([tx()], live, 10143, 1_000)).toBe(true)
    expect(
      sponsorable(
        Array.from({ length: SPONSOR_BATCH }, () => tx()),
        { ...live, policy: { ...policy, calls: BigInt(SPONSOR_BATCH) } },
        10143,
        1_000,
      ),
    ).toBe(true)
  })

  it('leaves everything else to the wallet', () => {
    expect(sponsorable([tx()], null, 10143, 1_000)).toBe(false)
    expect(sponsorable([], live, 10143, 1_000)).toBe(false)
    expect(
      sponsorable(
        Array.from({ length: SPONSOR_BATCH + 1 }, () => tx()),
        live,
        10143,
        1_000,
      ),
    ).toBe(false)
    // An ERC-20 approve before a top-up: the token is not a Sidequest contract, so the whole step goes from the wallet.
    expect(sponsorable([tx({ to: token, data: '0x095ea7b3' }), tx()], live, 10143, 1_000)).toBe(false)
    expect(sponsorable([tx({ data: '0xa9059cbb' })], live, 10143, 1_000)).toBe(false)
    expect(sponsorable([{ ...tx(), value: '1' } as unknown as TxRequest], live, 10143, 1_000)).toBe(false)
    expect(sponsorable([tx({ chainId: 143 })], live, 10143, 1_000)).toBe(false)
    expect(sponsorable([tx(), tx()], { policy, callsUsed: 4 }, 10143, 1_000)).toBe(false)
    expect(sponsorable([tx()], live, 10143, policy.validUntil - 30)).toBe(false)
  })
})

describe('a refused or lost sponsored send', () => {
  it('goes from the wallet when the board refuses for cap, floor, rate, policy or an inactive grant', () => {
    for (const reason of ['cap', 'floor', 'rate', 'unavailable', 'policy'])
      expect(submitFailure(new ApiError('conflict', 'no', reason))).toMatchObject({ kind: 'wallet' })
    expect(submitFailure(new ApiError('conflict', 'sponsorship is used'))).toMatchObject({
      kind: 'wallet',
      why: expect.stringMatching(/not active/),
    })
    expect(submitFailure(new ApiError('unauthenticated', 'sign in'))).toMatchObject({ kind: 'wallet' })
    expect(submitFailure(new ApiError('forbidden', 'outside the policy'))).toMatchObject({ kind: 'wallet' })
  })

  it('says why when it would fail or the relay is busy, and retries anything without a definite answer', () => {
    expect(submitFailure(new ApiError('chain', 'reverts', 'simulation'))).toMatchObject({
      kind: 'failed',
      message: expect.stringMatching(/would fail/),
    })
    expect(submitFailure(new ApiError('conflict', 'busy', 'pending'))).toMatchObject({
      kind: 'failed',
      message: expect.stringMatching(/earlier transaction/),
    })
    expect(submitFailure(new TypeError('Failed to fetch'))).toEqual({ kind: 'lost' })
    expect(submitFailure(new SyntaxError('Unexpected token <'))).toEqual({ kind: 'lost' })
    expect(submitFailure(new ApiError('500', 'request failed'))).toEqual({ kind: 'lost' })
  })

  it('keys each send for the board to dedupe its retries', () => {
    const k = sponsorKey()
    expect(k).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(sponsorKey()).not.toBe(k)
  })
})
