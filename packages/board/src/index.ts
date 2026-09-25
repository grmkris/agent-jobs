/**
 * The board model (spec §5, spike S6): projects own tasks; a task becomes one or more agreements; an
 * agreement is the pinned economic commitment behind one core job. Pure: every rule here is a function over
 * plain values, so it runs in Node, in the Durable Object, and in the SDK's client-side checks.
 */

/** How a task finds its worker. Hire-first assigns one applicant; a contest picks one finished candidate. */
export type TaskMode = 'hire-first' | 'contest'

/** The off-chain lifecycle of a hire-first task (spec §5). On-chain facts are mirrored, never decided, here. */
export type HireFirstStatus =
  | 'available'
  | 'reserved'
  | 'assigned'
  | 'accepted'
  | 'funded'
  | 'drafts'
  | 'finalized'
  | 'decided'
  | 'disputed'
  | 'settled'

/** The off-chain lifecycle of a contest until a winner is picked; from `selected` on it is hire-first. */
export type ContestStatus = 'open' | 'candidates' | 'selected' | 'expired'

export type TaskStatus = HireFirstStatus | ContestStatus

export const HIRE_FIRST_TRANSITIONS: Readonly<Record<HireFirstStatus, readonly HireFirstStatus[]>> = {
  available: ['reserved'],
  reserved: ['available', 'assigned'],
  assigned: ['accepted'],
  accepted: ['funded'],
  funded: ['drafts', 'finalized'],
  drafts: ['drafts', 'finalized'],
  finalized: ['decided', 'disputed'],
  decided: ['settled'],
  disputed: ['settled'],
  settled: [],
}

export const CONTEST_TRANSITIONS: Readonly<Record<ContestStatus, readonly TaskStatus[]>> = {
  open: ['candidates', 'expired'],
  candidates: ['candidates', 'selected', 'expired'],
  // A picked entrant continues as an assigned hire-first worker: bond, budget, fund, finalize.
  selected: ['accepted'],
  expired: [],
}

/**
 * @param from The current status.
 * @param to The requested status.
 * @returns Whether the board may move the task from `from` to `to`.
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from in HIRE_FIRST_TRANSITIONS) {
    return (HIRE_FIRST_TRANSITIONS[from as HireFirstStatus] as readonly TaskStatus[]).includes(to)
  }
  return CONTEST_TRANSITIONS[from as ContestStatus].includes(to)
}

/** `release_job` is valid only before the on-chain assignment boundary. */
export function canRelease(status: TaskStatus): boolean {
  return status === 'reserved'
}

/** "Silence is acceptance" applies to an assigned worker's finalized submission, never to contest entrants. */
export function silenceIsAcceptance(mode: TaskMode, status: TaskStatus): boolean {
  return mode === 'hire-first' && status === 'finalized'
}

// -------------------------------------------------------------------------------------------------
// Projects and roles
// -------------------------------------------------------------------------------------------------

/** A project-defined role. Names are free (developer, reviewer, security-reviewer, ...); nothing is fixed. */
export interface Role {
  name: string
  /** Whether a task requiring this role admits agents that merely declare it, or only certified ones. */
  requiresCertification: boolean
}

/** A persistent owner of work: context, members, roles, defaults, budget. */
export interface Project {
  projectId: string
  name: string
  /** The wallet that publishes on-chain for this project and can certify agents. */
  controller: `0x${string}`
  roles: readonly Role[]
  /** Defaults a new task inherits; pinned onto the agreement when accepted, never retroactive. */
  defaults: TaskDefaults
  policyVersion: number
}

export interface TaskDefaults {
  reviewWindowSeconds: number
  disputeWindowSeconds: number
  creatorBond: bigint
  workerBond: bigint
  /** Named CI checks and the trusted producing app an evidence attestation must cover. */
  evidencePolicy?: EvidencePolicy
}

export interface EvidencePolicy {
  checks: readonly string[]
  trustedProducer: string
  workflowPath: string
}

/** A task: something that needs doing. Not yet a payment agreement. */
export interface Task {
  taskId: string
  mode: TaskMode
  projectId?: string
  /** A role name from the project; absent means anyone with the hold gate may apply. */
  roleRequired?: string
  /** The project's `policyVersion` at creation; the agreement pins the resolved terms. */
  policyVersion: number
  status: TaskStatus
}

/** What an agent knows about itself and what projects have said about it (read from ERC-8004). */
export interface AgentRoleView {
  agentId: bigint
  /** Self-declared, from the identity registry metadata key `agent-jobs.roles`. */
  declared: readonly string[]
  /** Certified, from reputation feedback with `tag1 = "role"`: role name → certifying client addresses. */
  certifiedBy: Readonly<Record<string, readonly `0x${string}`[]>>
}

/** The metadata key on the ERC-8004 identity registry where an agent lists its roles, comma-separated. */
export const ROLES_METADATA_KEY = 'agent-jobs.roles'

/** The feedback tag a project uses to certify an agent for a role (`tag2` carries the role name). */
export const ROLE_FEEDBACK_TAG = 'role'

/**
 * @param value The raw metadata bytes decoded as UTF-8.
 * @returns The declared role names, trimmed, lower-cased, de-duplicated.
 */
export function parseDeclaredRoles(value: string): string[] {
  return [...new Set(value.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean))]
}

export type RoleGateOutcome =
  | { admitted: true; reason: 'no-role-required' | 'declared' | 'certified' }
  | { admitted: false; reason: 'not-declared' | 'not-certified' | 'unknown-role' }

/**
 * Whether an agent may apply to or claim a task, given the project's role definition and what the agent has
 * declared and been certified for (spec §1 "Projects and roles").
 * @param task The task, possibly requiring a role.
 * @param project The project that defines the role, or undefined for a standalone task.
 * @param agent The agent's declared roles and certifications.
 */
export function roleGate(task: Task, project: Project | undefined, agent: AgentRoleView): RoleGateOutcome {
  if (!task.roleRequired) return { admitted: true, reason: 'no-role-required' }
  const role = project?.roles.find((r) => r.name === task.roleRequired)
  if (!role) return { admitted: false, reason: 'unknown-role' }
  const declared = agent.declared.includes(role.name)
  if (!role.requiresCertification) {
    return declared ? { admitted: true, reason: 'declared' } : { admitted: false, reason: 'not-declared' }
  }
  const certifiers = agent.certifiedBy[role.name] ?? []
  const certified =
    project !== undefined && certifiers.some((c) => c.toLowerCase() === project.controller.toLowerCase())
  return certified ? { admitted: true, reason: 'certified' } : { admitted: false, reason: 'not-certified' }
}

// -------------------------------------------------------------------------------------------------
// Agreements
// -------------------------------------------------------------------------------------------------

/** The pinned economic commitment behind one core job. Nothing here changes after acceptance. */
export interface Agreement {
  agreementId: string
  taskId: string
  jobId: bigint
  worker: `0x${string}`
  agentId: bigint
  token: `0x${string}`
  reward: bigint
  creatorBond: bigint
  workerBond: bigint
  policyVersion: number
  evidencePolicy?: EvidencePolicy
  reviewWindowSeconds: number
  disputeWindowSeconds: number
}

/** The parts of an agreement that come from the parties rather than from the project's defaults. */
export type AgreementInput = Pick<Agreement, 'agreementId' | 'taskId' | 'jobId' | 'worker' | 'agentId' | 'token' | 'reward'> &
  Partial<Pick<Agreement, 'creatorBond' | 'workerBond'>>

/**
 * Builds the agreement from the task and the project's defaults *as they are now*; later project changes never
 * touch it.
 */
export function pinAgreement(input: AgreementInput, task: Task, defaults: TaskDefaults): Agreement {
  return {
    ...input,
    creatorBond: input.creatorBond ?? defaults.creatorBond,
    workerBond: input.workerBond ?? defaults.workerBond,
    policyVersion: task.policyVersion,
    ...(defaults.evidencePolicy ? { evidencePolicy: structuredClone(defaults.evidencePolicy) } : {}),
    reviewWindowSeconds: defaults.reviewWindowSeconds,
    disputeWindowSeconds: defaults.disputeWindowSeconds,
  }
}
