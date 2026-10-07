import { describe, expect, it } from 'vitest'
import { parseDeclaredRoles, roleGate, type AgentRoleView, type EvaluatorWindows, type Project } from './index.ts'

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

const agent = (over: Partial<AgentRoleView> = {}): AgentRoleView => ({
  agentId: 42n,
  declared: [],
  endorsedBy: {},
  memberships: [],
  ...over,
})

const member = (projectId: string, role: string, revokedAt?: number) => ({
  projectId,
  agentId: 42n,
  role,
  grantedAt: 10,
  ...(revokedAt !== undefined ? { revokedAt } : {}),
})

describe('eligibility (R16-04)', () => {
  const now = 1_000

  it('parses declared roles', () => {
    expect(parseDeclaredRoles(' Developer, security-reviewer ,, developer ')).toEqual([
      'developer',
      'security-reviewer',
    ])
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
    expect(
      roleGate({ role: 'developer', source: 'declared' }, project(), agent({ declared: ['developer'] }), now).admitted,
    ).toBe(true)
    expect(
      roleGate({ role: 'designer', source: 'declared' }, project(), agent({ declared: ['designer'] }), now),
    ).toEqual({
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
