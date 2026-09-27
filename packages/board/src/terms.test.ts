import { describe, expect, it } from 'vitest'
import {
  TermsError,
  canonicalJson,
  listingMatches,
  parseTerms,
  termsHash,
  validateOffer,
  type EvaluatorWindows,
  type OfferTerms,
} from './index.ts'

const WINDOWS: EvaluatorWindows = { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 }
const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const
const NOW = 1_800_000_000

const offer = (over: Partial<OfferTerms> = {}): OfferTerms => ({
  v: 2,
  deployment: { chainId: 10143, core: A(1), holding: A(2), evaluator: A(3), identity: A(4) },
  taskId: 't1',
  projectId: null,
  policyVersion: null,
  mode: 'hire',
  title: 'Add CI',
  brief: 'Run the tests on push',
  acceptanceCriteria: ['a named check passes on the submitted SHA'],
  token: A(5),
  reward: 25_000_000n,
  creatorBond: 5n * 10n ** 18n,
  workerBond: 3n * 10n ** 18n,
  deliveryDeadline: NOW + 600,
  selectionDeadline: null,
  creator: A(6),
  approver: A(6),
  windows: { ...WINDOWS },
  eligibility: null,
  evidencePolicy: null,
  quote: null,
  salt: `0x${'11'.repeat(32)}`,
  ...over,
})

describe('offers (spec §1 "Offers")', () => {
  it('canonical JSON sorts keys and stringifies bigints', () => {
    expect(canonicalJson({ b: 2n, a: { d: 1, c: [3n] } })).toBe('{"a":{"c":["3"],"d":1},"b":"2"}')
  })

  it('the manifest round-trips to the same termsHash', () => {
    const o = offer()
    expect(termsHash(parseTerms(canonicalJson(o)))).toBe(termsHash(o))
  })

  it('a different salt is a different offer (a retry is a new agreement)', () => {
    expect(termsHash(offer())).not.toBe(termsHash(offer({ salt: `0x${'22'.repeat(32)}` })))
  })

  it('refuses what the contracts would refuse', () => {
    expect(() => validateOffer(offer(), WINDOWS, NOW)).not.toThrow()
    expect(() => validateOffer(offer({ windows: { ...WINDOWS, reviewSeconds: 1 } }), WINDOWS, NOW)).toThrow(TermsError)
    expect(() => validateOffer(offer({ reward: 0n }), WINDOWS, NOW)).toThrow('reward')
    expect(() => validateOffer(offer({ deliveryDeadline: NOW }), WINDOWS, NOW)).toThrow('passed')
    expect(() => validateOffer(offer({ mode: 'contest', selectionDeadline: NOW + 60 }), WINDOWS, NOW)).toThrow(
      'no worker bond',
    )
    expect(() =>
      validateOffer(offer({ mode: 'contest', workerBond: 0n, selectionDeadline: NOW + 600 }), WINDOWS, NOW),
    ).toThrow('precede')
    expect(() =>
      validateOffer(offer({ mode: 'contest', workerBond: 0n, selectionDeadline: NOW + 60 }), WINDOWS, NOW),
    ).not.toThrow()
    expect(() => validateOffer(offer({ selectionDeadline: NOW + 60 }), WINDOWS, NOW)).toThrow('no selection')
  })

  it('a listing matches only on every enforceable field', () => {
    const o = offer()
    const hash = termsHash(o)
    const listing = {
      creator: o.creator,
      approver: o.approver,
      token: o.token,
      reward: o.reward,
      creatorBond: o.creatorBond,
      workerBond: o.workerBond,
      deliveryDeadline: o.deliveryDeadline,
      selectionDeadline: 0,
      mode: 0,
      policyHash: hash,
    }
    expect(listingMatches(o, hash, listing)).toBe(true)
    expect(listingMatches(o, hash, { ...listing, reward: o.reward - 1n })).toBe(false)
    expect(listingMatches(o, hash, { ...listing, approver: A(9) })).toBe(false)
    expect(listingMatches(o, hash, { ...listing, mode: 1 })).toBe(false)
    expect(listingMatches({ ...o, reward: 1n }, hash, listing)).toBe(false)
  })
})
