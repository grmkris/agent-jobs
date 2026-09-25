import { describe, expect, it } from 'vitest'
import {
  CONTEST_TRANSITIONS,
  HIRE_FIRST_TRANSITIONS,
  canRelease,
  canTransition,
  parseDeclaredRoles,
  pinAgreement,
  roleGate,
  silenceIsAcceptance,
  type AgentRoleView,
  type Project,
  type Task,
  type TaskStatus,
} from './index.ts'

const controller = '0x00000000000000000000000000000000000000c1' as const
const other = '0x00000000000000000000000000000000000000c2' as const

const project: Project = {
  projectId: 'p1',
  name: 'agent-jobs',
  controller,
  roles: [
    { name: 'developer', requiresCertification: false },
    { name: 'security-reviewer', requiresCertification: true },
  ],
  defaults: { reviewWindowSeconds: 3 * 86_400, disputeWindowSeconds: 3 * 86_400, creatorBond: 20n, workerBond: 10n },
  policyVersion: 3,
}

const task = (roleRequired?: string): Task => ({
  taskId: 't1',
  mode: 'hire-first',
  projectId: 'p1',
  policyVersion: 3,
  status: 'available',
  ...(roleRequired ? { roleRequired } : {}),
})

const agent = (declared: string[], certifiedBy: AgentRoleView['certifiedBy'] = {}): AgentRoleView => ({
  agentId: 42n,
  declared,
  certifiedBy,
})

describe('transitions', () => {
  it('lets a reservation lapse back to available but never an assignment', () => {
    expect(canTransition('reserved', 'available')).toBe(true)
    expect(canTransition('assigned', 'available')).toBe(false)
    expect(canTransition('funded', 'available')).toBe(false)
  })

  it('allows release only while reserved', () => {
    const statuses = [...Object.keys(HIRE_FIRST_TRANSITIONS), ...Object.keys(CONTEST_TRANSITIONS)] as TaskStatus[]
    expect(statuses.filter(canRelease)).toEqual(['reserved'])
  })

  it('a contest continues as hire-first once a winner is selected', () => {
    expect(canTransition('open', 'candidates')).toBe(true)
    expect(canTransition('candidates', 'selected')).toBe(true)
    expect(canTransition('selected', 'accepted')).toBe(true)
    expect(canTransition('candidates', 'expired')).toBe(true)
    expect(canTransition('expired', 'selected')).toBe(false)
  })

  it('silence is acceptance only for a finalized assigned worker', () => {
    expect(silenceIsAcceptance('hire-first', 'finalized')).toBe(true)
    expect(silenceIsAcceptance('contest', 'candidates')).toBe(false)
    expect(silenceIsAcceptance('hire-first', 'drafts')).toBe(false)
  })
})

describe('roles', () => {
  it('parses declared roles from the metadata value', () => {
    expect(parseDeclaredRoles(' Developer, security-reviewer ,, developer ')).toEqual(['developer', 'security-reviewer'])
  })

  it('admits anyone when no role is required', () => {
    expect(roleGate(task(), project, agent([]))).toEqual({ admitted: true, reason: 'no-role-required' })
  })

  it('a declared role is enough when the project does not require certification', () => {
    expect(roleGate(task('developer'), project, agent(['developer']))).toEqual({ admitted: true, reason: 'declared' })
    expect(roleGate(task('developer'), project, agent([]))).toEqual({ admitted: false, reason: 'not-declared' })
  })

  it('a certified role needs feedback from this project, not from any project', () => {
    const t = task('security-reviewer')
    expect(roleGate(t, project, agent(['security-reviewer']))).toEqual({ admitted: false, reason: 'not-certified' })
    expect(roleGate(t, project, agent([], { 'security-reviewer': [other] }))).toEqual({
      admitted: false,
      reason: 'not-certified',
    })
    expect(roleGate(t, project, agent([], { 'security-reviewer': [controller] }))).toEqual({
      admitted: true,
      reason: 'certified',
    })
  })

  it('an unknown role name never admits', () => {
    expect(roleGate(task('designer'), project, agent(['designer']))).toEqual({ admitted: false, reason: 'unknown-role' })
    expect(roleGate(task('developer'), undefined, agent(['developer']))).toEqual({ admitted: false, reason: 'unknown-role' })
  })
})

describe('agreements', () => {
  it('pins the defaults at acceptance so a later project change cannot rewrite them', () => {
    const base = {
      agreementId: 'a1',
      taskId: 't1',
      jobId: 1n,
      worker: other,
      agentId: 42n,
      token: controller,
      reward: 100n,
    }
    const defaults = { ...project.defaults, evidencePolicy: { checks: ['test'], trustedProducer: 'github-actions', workflowPath: '.github/workflows/check.yml' } }
    const pinned = pinAgreement(base, task(), defaults)
    defaults.evidencePolicy.checks = ['nothing']
    defaults.reviewWindowSeconds = 1
    expect(pinned.evidencePolicy?.checks).toEqual(['test'])
    expect(pinned.reviewWindowSeconds).toBe(3 * 86_400)
    expect(pinned.creatorBond).toBe(20n)
    expect(pinned.policyVersion).toBe(3)
  })
})
