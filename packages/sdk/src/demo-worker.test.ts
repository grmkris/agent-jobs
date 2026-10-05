import { describe, expect, it } from 'vitest'
import { type DemoRequest, parseDemoBid, requestProblem, verifyBudgetAuthorization, verifyPickedTerms } from './demo-worker.ts'

const creator = '0x1111111111111111111111111111111111111111'
const token = '0x2222222222222222222222222222222222222222'
const core = '0x3333333333333333333333333333333333333333'
const request: DemoRequest = { requestId: 'request', requestHash: 'hash', chainId: 10143, stack: 'main', creator,
  title: 'Cats', brief: 'Draw cats', acceptanceCriteria: ['PNG'], tokens: [token], workerBond: '1', quoteDeadline: 2000,
  deliveryDeadline: 3000, requiredChecks: ['test'], windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 }, arbitrator: core } as DemoRequest
const policy = { creatorScope: 'any', token, maxBond: 5n * 10n ** 18n, minimumDeliverySeconds: 900 } as const

describe('demo worker admission', () => {
  it('admits any testnet creator while retaining economic and delivery constraints', () => {
    expect(requestProblem({ ...request, creator: core.toUpperCase() }, policy, 1000)).toBeUndefined()
    expect(requestProblem({ ...request, creator: token }, policy, 1000)).toBeUndefined()
    expect(requestProblem({ ...request, workerBond: '5', deliveryDeadline: 1900 }, policy, 1000)).toBeUndefined()
    expect(requestProblem({ ...request, workerBond: '5.000000000000000001' }, policy, 1000)).toBeDefined()
    expect(requestProblem({ ...request, deliveryDeadline: 1899 }, policy, 1000)).toBeDefined()
  })
  it('admits a scoped image request and a git-only image request', () => expect(requestProblem(request, policy, 1000)).toBeUndefined())
  it.each([{ chainId: 143 }, { tokens: [core] }, { workerBond: '11' }, { quoteDeadline: 999 },
    { deliveryDeadline: 1200 }, { requiredChecks: ['deploy'] }, { deliverable: { accepts: ['onchain'] } },
    { deliverable: { accepts: ['artifact'], target: 'Some other server' } }])('refuses unsafe or unsupported request %j', change => {
    expect(requestProblem({ ...request, ...change }, policy, 1000)).toBeTypeOf('string')
  })
  it('keeps delivery adapter checks for any creator', () => {
    expect(requestProblem({ ...request, creator: core, deliverable: { accepts: ['artifact'] } }, policy, 1000)).toBeDefined()
  })
})

describe('model output and frozen terms', () => {
  const bid = { safety: 'safe', kind: 'image', filename: 'cats.png', mediaType: 'image/png', note: 'A bright poster', prompt: 'Many cats' }
  it('accepts an assessed safe image plan and a decline', () => {
    const { safety: _safety, ...plan } = bid
    expect(parseDemoBid(bid)).toEqual(plan)
    expect(parseDemoBid({ decline: true })).toBeNull()
  })
  it.each(['unsafe', 'illegal', 'uncertain', undefined])('declines a plan with safety assessment %s', safety => {
    expect(parseDemoBid({ ...bid, safety })).toBeNull()
  })
  it.each(['../../.env.local', 'file.sh', 'cats.png/../../secret', 'https://outside/file.png'])('refuses model filename %s', filename => {
    expect(() => parseDemoBid({ ...bid, filename })).toThrow()
  })
  it('accepts JPEG image output and refuses mismatched declarations', () => {
    expect(parseDemoBid({ ...bid, filename: 'cats.jpg', mediaType: 'image/jpeg' })).not.toBeNull()
    expect(() => parseDemoBid({ ...bid, mediaType: 'text/html' })).toThrow()
  })
  const terms = { deployment: { chainId: 10143 }, creator, token, title: request.title, brief: request.brief,
    acceptanceCriteria: request.acceptanceCriteria, reward: '3000000', workerBond: '1000000000000000000', deliveryDeadline: 3000,
    arbitrator: core, windows: request.windows, quote: { requestHash: 'hash' } }
  it('checks a picked offer against the frozen quote before activation', () => {
    expect(() => verifyPickedTerms(request, terms, token, 3000000n)).not.toThrow()
    for (const change of [{ reward: '4000000' }, { arbitrator: token }, { workerBond: '0' }, { brief: 'Different work' }, { quote: { requestHash: 'other' } }])
      expect(() => verifyPickedTerms(request, { ...terms, ...change }, token, 3000000n)).toThrow()
  })
  it('signs net payment only and rejects cross-chain or cross-job budget requests', () => {
    const typed = { primaryType: 'SetBudgetAuthorization', domain: { chainId: 10143, verifyingContract: core },
      message: { signer: creator, jobId: '106', token, amount: '2100000' } }
    const expected = { core, wallet: creator, jobId: '106', token, net: '2100000' } as const
    expect(() => verifyBudgetAuthorization(JSON.stringify(typed), expected)).not.toThrow()
    expect(() => verifyBudgetAuthorization(JSON.stringify({ ...typed, message: { ...typed.message, amount: '3000000' } }), expected)).toThrow()
    expect(() => verifyBudgetAuthorization(JSON.stringify({ ...typed, domain: { ...typed.domain, chainId: 143 } }), expected)).toThrow()
  })
})
