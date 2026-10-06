import * as sdk from '@agent-jobs/sdk'
import { describe, expect, it } from 'vitest'
import { assertFreshAnchor, decodeExactCall, expectedPermission, permissionRequest, reviewPermission, tokenAmountText } from './permission-review.ts'
import { encodeFunctionData, erc20Abi } from 'viem'

const deployment = sdk.deployment('monad-testnet')
const operator = '0x1111111111111111111111111111111111111111' as const
const agent = '0x2222222222222222222222222222222222222222' as const
const recipient = '0x3333333333333333333333333333333333333333' as const
const token = deployment.rewardTokens[0]!
const now = 1_791_000_000
const terms: sdk.PermissionTerms = { type: 'erc20-token-periodic', token, periodAmount: 10n, periodDuration: 86_400, recipient }
const requestJson = JSON.stringify({ terms: JSON.stringify(terms, (_, v) => typeof v === 'bigint' ? v.toString() : v), expiry: now + 7 * 86_400, adjustable: true, justification: 'top-ups', standing: false })

/** What the board prepares for a given final choice. */
function prepared(final: { terms: sdk.PermissionTerms; expiry: number }, salt = 77n, start = now) {
  const spec: sdk.PermissionSpec = { kind: 'permission', delegator: operator, agent, salt, start, expiry: final.expiry, terms: final.terms }
  const grant = sdk.buildPermission(deployment, spec)
  return { hash: sdk.delegationHash(grant), grant: JSON.parse(sdk.delegationJson(grant)), description: { validAfter: start } }
}

describe('permission review', () => {
  it('accepts the server template that equals the request as the operator adjusted it', () => {
    const request = permissionRequest(requestJson)
    const final = expectedPermission(request, { amount: 4n, expiry: now + 86_400 })
    const review = reviewPermission(deployment, prepared(final), { operator, agent, terms: final.terms, expiry: final.expiry, adjusted: true }, now)
    expect(review.description).toMatchObject({ amount: '4', recipient, expiresAt: now + 86_400 })
    expect(review.risks.map(risk => risk.code)).toEqual(['adjusted'])
  })

  it('refuses a template that differs from what the operator chose', () => {
    const request = permissionRequest(requestJson)
    const chosen = expectedPermission(request, { amount: 4n })
    const served = prepared({ terms: { ...terms, periodAmount: 10n }, expiry: request.expiry })
    expect(() => reviewPermission(deployment, served, { operator, agent, terms: chosen.terms, expiry: chosen.expiry, adjusted: true }, now)).toThrow()
    const otherRecipient = prepared({ terms: { ...terms, recipient: agent }, expiry: request.expiry })
    expect(() => reviewPermission(deployment, otherRecipient, { operator, agent, terms, expiry: request.expiry, adjusted: false }, now)).toThrow()
    expect(() => reviewPermission(deployment, { ...prepared({ terms, expiry: request.expiry }), hash: `0x${'00'.repeat(32)}` }, { operator, agent, terms, expiry: request.expiry, adjusted: false }, now)).toThrow(/hash/)
  })

  it('refuses a backdated period anchor and shows when periods start and first refill (VV2-023)', () => {
    const request = permissionRequest(requestJson)
    const expected = { operator, agent, terms, expiry: request.expiry, adjusted: false }
    // A 10/day grant anchored a day minus one second ago would refill one second from now.
    expect(() => reviewPermission(deployment, prepared({ terms, expiry: request.expiry }, 77n, now - 86_399), expected, now)).toThrow(/out of date/)
    const recent = reviewPermission(deployment, prepared({ terms, expiry: request.expiry }, 77n, now - 600), expected, now)
    expect(recent.schedule).toEqual({ start: now - 600, firstRefill: now - 600 + 86_400 })
    // The same review, signed much later, is refused before the wallet prompt.
    expect(() => assertFreshAnchor(recent.terms, recent.start, now + 86_000)).toThrow(/out of date/)
    // Only a periodic anchor ages: an allowance or exact call keeps its one template.
    const allowance: sdk.PermissionTerms = { type: 'erc20-token-allowance', token, amount: 10n, recipient }
    expect(() => assertFreshAnchor(allowance, now - 86_399, now)).not.toThrow()
  })

  it('decodes an exact call in full and keeps base units for unknown tokens (VV2-022)', () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, 1000n] })
    expect(decodeExactCall(data)).toEqual({ functionName: 'transfer', args: [{ name: 'recipient', value: recipient }, { name: 'amount', value: '1000' }] })
    expect(decodeExactCall('0xdeadbeef')).toBeNull()
    expect(tokenAmountText(5n, recipient)).toBe(`5 base units of token ${recipient}`)
  })

  it('applies only shorter or lower adjustments', () => {
    const request = permissionRequest(requestJson)
    expect(() => expectedPermission(request, { amount: 11n })).toThrow()
    expect(() => expectedPermission(request, { expiry: request.expiry + 1 })).toThrow()
  })
})
