import { describe, expect, it } from 'vitest'
import { clocksFromConfig, PRODUCTION_CLOCKS, windowBounds } from '@sidequest/sdk'
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

describe('discovery tags in frozen terms', () => {
  it('leaves existing untagged signed manifests unchanged', () => {
    const original = offer()
    const back = parseTerms(canonicalJson(original))
    expect(back).not.toHaveProperty('tags')
    expect(termsHash(back)).toBe(termsHash(original))
    expect(termsHash({ ...original, tags: undefined } as unknown as OfferTerms)).toBe(termsHash(original))
  })
  it('binds the tags into the manifest without reordering stored signed terms', () => {
    const tagged = offer({ tags: ['research', 'coding'] })
    const back = parseTerms(canonicalJson(tagged))
    expect(back.tags).toEqual(['research', 'coding'])
    expect(termsHash(back)).toBe(termsHash(tagged))
    expect(termsHash(tagged)).not.toBe(termsHash(offer()))
  })
})

describe('v1 offer windows and arbitrator', () => {
  const windows = { reviewSeconds: 3600, disputeSeconds: 86400, arbitrationSeconds: 43200 }
  const v1 = () => offer({ windows, arbitrator: A(8) })
  it('accepts per-offer windows independently of legacy evaluator defaults', () => {
    expect(() => validateOffer(v1(), WINDOWS, NOW, 'sidequest-v1')).not.toThrow()
    expect(termsHash(v1())).not.toBe(termsHash({ ...v1(), arbitrator: A(9) }))
  })
  it('accepts testnet minute clocks and refuses the second before each deployed minimum', () => {
    const fast = { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 }
    const bounds = windowBounds(clocksFromConfig({ ...PRODUCTION_CLOCKS, minReviewWindow: 120, minDisputeWindow: 120, minArbitrationWindow: 300 }, 10143))
    const terms = offer({ windows: fast, arbitrator: A(8) })
    expect(() => validateOffer(terms, WINDOWS, NOW, 'sidequest-v1', bounds)).not.toThrow()
    expect(() => validateOffer(terms, WINDOWS, NOW, 'sidequest-v1')).toThrow('1 hour')
    for (const key of ['reviewSeconds', 'disputeSeconds', 'arbitrationSeconds'] as const)
      expect(() => validateOffer({ ...terms, windows: { ...fast, [key]: fast[key] - 1 } }, WINDOWS, NOW, 'sidequest-v1', bounds)).toThrow(TermsError)
    expect(() => validateOffer(terms, { ...WINDOWS, reviewSeconds: 3600 }, NOW, 'legacy', bounds)).toThrow('deployed evaluator')
  })
  it.each([['reviewSeconds', 3599], ['disputeSeconds', 1209601], ['arbitrationSeconds', 43199], ['reviewSeconds', 3600.5]])('refuses out-of-range %s', (key, value) => {
    expect(() => validateOffer({ ...v1(), windows: { ...windows, [key]: value } }, WINDOWS, NOW, 'sidequest-v1')).toThrow('window')
  })
  it.each([undefined, A(0), A(6)])('refuses a missing, zero or party arbitrator %s', arbitrator => {
    expect(() => validateOffer(offer({ windows, ...(arbitrator === undefined ? {} : { arbitrator }) }), WINDOWS, NOW, 'sidequest-v1')).toThrow('arbitrator')
  })
})

describe('execution budget in the terms (ADR-0009)', () => {
  const budget = { kind: 'advance' as const, token: A(7), cap: 2n * 10n ** 18n, expiresAt: NOW + 300 }

  it('an offer without a budget hashes exactly as before (the key is absent, not null)', () => {
    const o = offer()
    expect(canonicalJson(o)).not.toContain('executionBudget')
    expect(termsHash({ ...o, executionBudget: undefined } as unknown as OfferTerms)).toBe(termsHash(o))
  })

  it('an advance is bound into the terms hash and survives the manifest round trip', () => {
    const o = offer({ executionBudget: budget })
    expect(termsHash(o)).not.toBe(termsHash(offer()))
    const back = parseTerms(canonicalJson(o))
    expect(back.executionBudget).toEqual(budget)
    expect(termsHash(back)).toBe(termsHash(o))
    expect(termsHash(offer({ executionBudget: { ...budget, cap: budget.cap + 1n } }))).not.toBe(termsHash(o))
  })

  it('hire only, positive, expiring in the future and no later than the delivery deadline', () => {
    expect(() => validateOffer(offer({ executionBudget: budget }), WINDOWS, NOW)).not.toThrow()
    expect(() => validateOffer(offer({ executionBudget: { ...budget, expiresAt: NOW + 600 } }), WINDOWS, NOW)).not.toThrow()
    const contest = offer({ mode: 'contest', workerBond: 0n, selectionDeadline: NOW + 300, executionBudget: budget })
    expect(() => validateOffer(contest, WINDOWS, NOW)).toThrow('Only a hire')
    expect(() => validateOffer(offer({ executionBudget: { ...budget, cap: 0n } }), WINDOWS, NOW)).toThrow('positive')
    expect(() => validateOffer(offer({ executionBudget: { ...budget, expiresAt: NOW } }), WINDOWS, NOW)).toThrow('expires')
    expect(() => validateOffer(offer({ executionBudget: { ...budget, expiresAt: NOW + 601 } }), WINDOWS, NOW)).toThrow('expires')
  })

  it('a call budget names one function, may send no value, round-trips and is bound into the hash', () => {
    const call = { kind: 'call' as const, target: A(8), function: 'function create((string,string) params) payable', cap: 10n ** 19n, expiresAt: NOW + 300 }
    const o = offer({ executionBudget: call })
    expect(() => validateOffer(o, WINDOWS, NOW)).not.toThrow()
    expect(() => validateOffer(offer({ executionBudget: { ...call, function: 'function faucet()', cap: 0n } }), WINDOWS, NOW)).not.toThrow()
    expect(parseTerms(canonicalJson(o)).executionBudget).toEqual(call)
    expect(termsHash(parseTerms(canonicalJson(o)))).toBe(termsHash(o))
    expect(() => validateOffer(offer({ executionBudget: { ...call, function: 'event Created(address)' } }), WINDOWS, NOW)).toThrow('one function')
    expect(() => validateOffer(offer({ executionBudget: { ...call, function: 'not abi' } }), WINDOWS, NOW)).toThrow('one function')
  })

  it('stored terms with a retired budget shape do not parse', () => {
    const json = canonicalJson(offer()).replace(/}$/, ',"executionBudget":{"cap":"1","expiresAt":1,"token":"0x0000000000000000000000000000000000000007"}}')
    expect(() => parseTerms(json)).toThrow(TermsError)
  })
})

const bad = (deliverable: NonNullable<OfferTerms['deliverable']>, over: Partial<OfferTerms> = {}) => () =>
  validateOffer(offer({ deliverable, ...over }), WINDOWS, NOW)

describe('accepted deliverables in the terms (ADR-0006)', () => {
  it('an offer without the field hashes as before and means git only', () => {
    const o = offer()
    expect(canonicalJson(o)).not.toContain('deliverable')
    expect(termsHash({ ...o, deliverable: undefined } as unknown as OfferTerms)).toBe(termsHash(o))
  })

  it('the accepted kinds are bound into the terms hash and survive the manifest round trip', () => {
    const o = offer({ deliverable: { accepts: ['git', 'artifact'], target: 'IPFS is fine' } })
    expect(termsHash(o)).not.toBe(termsHash(offer()))
    expect(termsHash(parseTerms(canonicalJson(o)))).toBe(termsHash(o))
  })

  it('refuses an empty or unknown list, and an evidence policy without git', () => {
    expect(bad({ accepts: [] })).toThrow(TermsError)
    expect(bad({ accepts: ['zip' as 'git'] })).toThrow(TermsError)
    const policy = { checks: ['test'], trustedProducer: 'github-actions', workflowPath: '.github/workflows' }
    expect(bad({ accepts: ['artifact'] }, { evidencePolicy: policy })).toThrow(/must accept git/)
    expect(bad({ accepts: ['git', 'artifact'] }, { evidencePolicy: policy })).not.toThrow()
  })
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
