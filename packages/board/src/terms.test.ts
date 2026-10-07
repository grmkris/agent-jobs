import { describe, expect, it } from 'vitest'
import { clocksFromConfig, PRODUCTION_CLOCKS, windowBounds } from '@sidequest/sdk'
import { canonicalJson, listingMatches, parseTerms, termsHash, validateOffer, type OfferTerms } from './terms.ts'

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const
const NOW = 1_800_000_000
const windows = { reviewSeconds: 3600, disputeSeconds: 7200, arbitrationSeconds: 43200 }
const offer = (over: Partial<OfferTerms> = {}): OfferTerms => ({
  v: 2,
  mode: 'hire',
  deployment: { chainId: 10143, core: A(1), holding: A(2), evaluator: A(3), identity: A(4) },
  taskId: 't1',
  projectId: null,
  policyVersion: null,
  title: 'Add CI',
  brief: 'Run tests',
  acceptanceCriteria: ['tests pass'],
  token: A(5),
  reward: 25_000_000n,
  creatorBond: 5n,
  workerBond: 3n,
  deliveryDeadline: NOW + 600,
  creator: A(6),
  approver: A(6),
  arbitrator: A(8),
  windows,
  eligibility: null,
  evidencePolicy: null,
  quote: null,
  salt: `0x${'11'.repeat(32)}`,
  ...over,
})
const validate = (o: OfferTerms) => validateOffer(o, windows, NOW)

describe('frozen v1 terms', () => {
  it('round-trips signed fields without reordering tags or adding optional fields', () => {
    const o = offer({ tags: ['writing', 'coding'] })
    expect(parseTerms(canonicalJson(o))).toEqual(o)
    expect(termsHash(parseTerms(canonicalJson(o)))).toBe(termsHash(o))
    expect(offer()).not.toHaveProperty('executionBudget')
    expect(termsHash(o)).not.toBe(termsHash(offer({ tags: ['coding', 'writing'] })))
    expect(termsHash(o)).not.toBe(termsHash({ ...o, salt: `0x${'22'.repeat(32)}` }))
    expect(canonicalJson({ z: 1n, a: { z: 2, a: 3 } })).toBe('{"a":{"a":3,"z":2},"z":"1"}')
  })
  it('checks per-offer windows against deployed bounds, including minute clocks', () => {
    expect(() => validate(offer())).not.toThrow()
    const fast = { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 }
    const bounds = windowBounds(
      clocksFromConfig(
        { ...PRODUCTION_CLOCKS, minReviewWindow: 120, minDisputeWindow: 120, minArbitrationWindow: 300 },
        10143,
      ),
    )
    expect(() => validateOffer(offer({ windows: fast }), windows, NOW, 'sidequest-v1', bounds)).not.toThrow()
    for (const key of ['reviewSeconds', 'disputeSeconds', 'arbitrationSeconds'] as const)
      expect(() =>
        validateOffer(offer({ windows: { ...fast, [key]: fast[key] - 1 } }), windows, NOW, 'sidequest-v1', bounds),
      ).toThrow('window')
    expect(() => validate(offer({ windows: { ...windows, reviewSeconds: 3599 } }))).toThrow('window')
    expect(() => validate(offer({ windows: { ...windows, disputeSeconds: 1209601 } }))).toThrow('window')
  })
  it('refuses party arbitrators, missing arbitration, expired deadlines and invalid amounts', () => {
    const missing = offer()
    delete missing.arbitrator
    expect(() => validate(missing)).toThrow('arbitrator')
    for (const arbitrator of [A(0), A(6)]) expect(() => validate(offer({ arbitrator }))).toThrow('arbitrator')
    expect(() => validate(offer({ reward: 0n }))).toThrow('reward')
    expect(() => validate(offer({ workerBond: -1n }))).toThrow('reward')
    expect(() => validate(offer({ deliveryDeadline: NOW }))).toThrow('passed')
  })
  it('matches every enforceable listing field and the frozen arbitrator', () => {
    const o = offer(),
      hash = termsHash(o)
    const listing = {
      creator: o.creator,
      approver: o.approver,
      token: o.token,
      reward: o.reward,
      creatorBond: o.creatorBond,
      workerBond: o.workerBond,
      deliveryDeadline: o.deliveryDeadline,
      policyHash: hash,
      arbitrator: A(8),
    }
    expect(listingMatches(o, hash, listing)).toBe(true)
    expect(listingMatches(o, hash, { ...listing, arbitrator: A(9) })).toBe(false)
    expect(listingMatches(o, hash, { ...listing, workerBond: 0n })).toBe(false)
    expect(listingMatches(o, hash, { ...listing, reward: 1n })).toBe(false)
    expect(listingMatches({ ...o, reward: 1n }, hash, listing)).toBe(false)
  })
  it('binds budgets and deliverable specs into the manifest and enforces their limits', () => {
    const budget = { kind: 'advance' as const, token: A(7), cap: 2n, expiresAt: NOW + 300 }
    const o = offer({ executionBudget: budget, deliverable: { accepts: ['git', 'url'] } })
    expect(() => validate(o)).not.toThrow()
    expect(parseTerms(canonicalJson(o))).toEqual(o)
    expect(termsHash(o)).not.toBe(termsHash(offer()))
    for (const expiresAt of [NOW, NOW + 601])
      expect(() => validate(offer({ executionBudget: { ...budget, expiresAt } }))).toThrow('expires')
    expect(() => validate(offer({ executionBudget: { ...budget, cap: 0n } }))).toThrow('positive')
    const call = {
      kind: 'call' as const,
      target: A(7),
      function: 'function create() payable',
      cap: 0n,
      expiresAt: NOW + 300,
    }
    expect(() => validate(offer({ executionBudget: call }))).not.toThrow()
    expect(() => validate(offer({ executionBudget: { ...call, function: 'event Created()' } }))).toThrow('function')
    expect(() => validate(offer({ deliverable: { accepts: [] } }))).toThrow('Deliverable')
    expect(() =>
      validate(
        offer({
          deliverable: { accepts: ['url'] },
          evidencePolicy: { checks: ['test'], trustedProducer: 'github-actions', workflowPath: '.github/workflows' },
        }),
      ),
    ).toThrow('git')
    expect(() =>
      parseTerms(canonicalJson({ ...o, executionBudget: { kind: 'retired', cap: '1', expiresAt: NOW + 1 } })),
    ).toThrow('unknown execution budget')
  })
})
