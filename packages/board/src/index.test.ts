import { describe, expect, it } from 'vitest'
import {
  CONTEST_TRANSITIONS,
  HIRE_FIRST_TRANSITIONS,
  TermsError,
  canRelease,
  canTransition,
  canonicalJson,
  parseDeclaredRoles,
  pinAgreement,
  publishOffer,
  roleGate,
  silenceIsAcceptance,
  termsHash,
  type AgentRoleView,
  type Agreement,
  type EvaluatorWindows,
  type Project,
  type Task,
  type TaskStatus,
} from './index.ts'

const controller = '0x00000000000000000000000000000000000000c1' as const
const otherController = '0x00000000000000000000000000000000000000c2' as const
const token = '0x00000000000000000000000000000000000000aa' as const
const WINDOWS: EvaluatorWindows = { reviewSeconds: 259_200, disputeSeconds: 259_200, arbitrationSeconds: 604_800 }

const project = (id = 'p1', ctl: `0x${string}` = controller): Project => ({
  projectId: id,
  name: id,
  controller: ctl,
  roles: [{ name: 'developer' }, { name: 'security-reviewer' }],
  defaults: { token, creatorBond: 20n, workerBond: 10n, windows: { ...WINDOWS } },
  policyVersion: 1,
})

const task = (overrides: Partial<Task> = {}): Task => ({
  taskId: 't1',
  mode: 'hire-first',
  projectId: 'p1',
  status: 'available',
  ...overrides,
})

const agent = (over: Partial<AgentRoleView> = {}): AgentRoleView => ({
  agentId: 42n,
  declared: [],
  endorsedBy: {},
  memberships: [],
  ...over,
})

describe('transitions', () => {
  it('lets a reservation lapse back to available but never an assignment', () => {
    expect(canTransition('reserved', 'available')).toBe(true)
    expect(canTransition('assigned', 'available')).toBe(false)
  })

  it('allows release only while reserved', () => {
    const all = [...Object.keys(HIRE_FIRST_TRANSITIONS), ...Object.keys(CONTEST_TRANSITIONS)] as TaskStatus[]
    expect(all.filter(canRelease)).toEqual(['reserved'])
  })

  it('a live contest has no cancel edge; it ends by selection or expiry', () => {
    expect(CONTEST_TRANSITIONS.open).toEqual(['candidates', 'expired'])
    expect(canTransition('candidates', 'selected')).toBe(true)
    expect(canTransition('selected', 'accepted')).toBe(true)
    expect(canTransition('expired', 'selected')).toBe(false)
  })
})

describe('silence is acceptance (R16-03)', () => {
  const published = publishOffer(task({ mode: 'contest' }), project(), 100n, undefined, WINDOWS)
  const agreement: Agreement = {
    agreementId: 'a1',
    jobId: 1n,
    worker: otherController,
    agentId: 42n,
    terms: published.offer,
    termsHash: published.termsHash,
  }

  it('a selected, funded contest winner has the same right as a hired worker', () => {
    expect(silenceIsAcceptance(agreement, 'finalized')).toBe(true)
  })

  it('an unselected entrant has no agreement and no silence right', () => {
    expect(silenceIsAcceptance(undefined, 'finalized')).toBe(false)
    expect(silenceIsAcceptance(undefined, 'candidates')).toBe(false)
  })

  it('not before finalization', () => {
    expect(silenceIsAcceptance(agreement, 'drafts')).toBe(false)
  })
})

describe('eligibility (R16-04)', () => {
  const now = 1_000
  const member = (projectId: string, role: string, revokedAt?: number) => ({
    projectId,
    agentId: 42n,
    role,
    grantedAt: 10,
    ...(revokedAt !== undefined ? { revokedAt } : {}),
  })

  it('parses declared roles', () => {
    expect(parseDeclaredRoles(' Developer, security-reviewer ,, developer ')).toEqual(['developer', 'security-reviewer'])
  })

  it('open offers admit anyone', () => {
    expect(roleGate(undefined, project(), agent(), now)).toEqual({ admitted: true, reason: 'no-role-required' })
  })

  it('the controller can appoint its own agent through membership', () => {
    const a = agent({ memberships: [member('p1', 'developer')] })
    expect(roleGate({ role: 'developer', source: 'membership' }, project(), a, now)).toEqual({
      admitted: true,
      reason: 'member',
    })
  })

  it('an endorsement-required policy is never satisfied by membership', () => {
    const a = agent({ memberships: [member('p1', 'security-reviewer')] })
    expect(roleGate({ role: 'security-reviewer', source: 'endorsement' }, project(), a, now)).toEqual({
      admitted: false,
      reason: 'not-endorsed',
    })
    const e = agent({ endorsedBy: { 'security-reviewer': [controller] } })
    expect(roleGate({ role: 'security-reviewer', source: 'endorsement' }, project(), e, now)).toEqual({
      admitted: true,
      reason: 'endorsed',
    })
  })

  it('membership in project A never admits to project B, even with the same controller', () => {
    const a = agent({ memberships: [member('A', 'developer')] })
    const b = project('B', controller)
    expect(roleGate({ role: 'developer', source: 'membership' }, b, a, now)).toEqual({
      admitted: false,
      reason: 'not-member',
    })
  })

  it('revocation stops new admissions', () => {
    const a = agent({ memberships: [member('p1', 'developer', 500)] })
    expect(roleGate({ role: 'developer', source: 'membership' }, project(), a, now).admitted).toBe(false)
    expect(roleGate({ role: 'developer', source: 'membership' }, project(), a, 400).admitted).toBe(true)
  })

  it('declared and unknown roles', () => {
    expect(roleGate({ role: 'developer', source: 'declared' }, project(), agent({ declared: ['developer'] }), now).admitted).toBe(true)
    expect(roleGate({ role: 'designer', source: 'declared' }, project(), agent({ declared: ['designer'] }), now)).toEqual({
      admitted: false,
      reason: 'unknown-role',
    })
  })

  it('membership-or-endorsement accepts either', () => {
    const p = { role: 'developer', source: 'membership-or-endorsement' } as const
    expect(roleGate(p, project(), agent({ endorsedBy: { developer: [controller] } }), now).reason).toBe('endorsed')
    expect(roleGate(p, project(), agent({ endorsedBy: { developer: [otherController] } }), now).admitted).toBe(false)
  })
})

describe('offers and agreements (R16-05)', () => {
  it('canonical JSON sorts keys and stringifies bigints', () => {
    expect(canonicalJson({ b: 2n, a: { d: 1, c: [3n] } })).toBe('{"a":{"c":["3"],"d":1},"b":"2"}')
  })

  it('a v1 offer keeps v1 values and identity after the project moves to v2', () => {
    const p = project()
    const published = publishOffer(task(), p, 100n, undefined, WINDOWS)
    p.defaults.creatorBond = 999n
    p.defaults.windows.reviewSeconds = 1
    p.policyVersion = 2
    expect(published.offer.creatorBond).toBe(20n)
    expect(published.offer.policyVersion).toBe(1)
    expect(published.offer.windows.reviewSeconds).toBe(WINDOWS.reviewSeconds)
    expect(termsHash(published.offer)).toBe(published.termsHash)
  })

  it('unsupported windows are refused at publish', () => {
    const p = project()
    p.defaults.windows = { ...WINDOWS, reviewSeconds: 60 }
    expect(() => publishOffer(task(), p, 100n, undefined, WINDOWS)).toThrow(TermsError)
  })

  it('pins only against a matching on-chain listing', () => {
    const published = publishOffer(task(), project(), 100n, undefined, WINDOWS)
    const listing = { token, reward: 100n, creatorBond: 20n, workerBond: 10n, policyHash: published.termsHash }
    const input = { agreementId: 'a1', jobId: 7n, worker: otherController, agentId: 42n }
    const agreement = pinAgreement(input, published, listing)
    expect(agreement.termsHash).toBe(published.termsHash)

    expect(() => pinAgreement(input, published, { ...listing, reward: 99n })).toThrow('does not match')
    expect(() => pinAgreement(input, published, { ...listing, workerBond: 0n })).toThrow('does not match')
    expect(() => pinAgreement(input, published, { ...listing, policyHash: `0x${'00'.repeat(32)}` })).toThrow(
      'does not match',
    )
  })

  it('a tampered offer cannot be pinned under the original hash', () => {
    const published = publishOffer(task(), project(), 100n, undefined, WINDOWS)
    const tampered = { offer: { ...published.offer, reward: 1n }, termsHash: published.termsHash }
    const listing = { token, reward: 1n, creatorBond: 20n, workerBond: 10n, policyHash: published.termsHash }
    expect(() =>
      pinAgreement({ agreementId: 'a', jobId: 1n, worker: otherController, agentId: 1n }, tampered, listing),
    ).toThrow('does not hash')
  })

  it('the accepted snapshot is a copy that later edits cannot mutate', () => {
    const published = publishOffer(task(), project(), 100n, undefined, WINDOWS)
    const listing = { token, reward: 100n, creatorBond: 20n, workerBond: 10n, policyHash: published.termsHash }
    const agreement = pinAgreement({ agreementId: 'a', jobId: 1n, worker: otherController, agentId: 1n }, published, listing)
    ;(published.offer as { reward: bigint }).reward = 5n
    expect(agreement.terms.reward).toBe(100n)
  })
})
