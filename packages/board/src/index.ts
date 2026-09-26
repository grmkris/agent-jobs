/**
 * The board model (spec §5): projects own tasks; a task publishes one frozen offer; a worker's agreement pins
 * that exact offer and the on-chain listing behind one core job. Pure: every rule is a function over plain
 * values, so it runs in Node, in the Durable Object, and in the SDK's client-side checks.
 */
import { keccak256, stringToHex, type Hex } from 'viem'

/** How a task finds its worker. Hire-first assigns one applicant; a contest picks one finished candidate. */
export type TaskMode = 'hire-first' | 'contest'

/** The off-chain lifecycle of a hire-first task. On-chain facts are mirrored, never decided, here. */
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

/** The off-chain lifecycle of a contest until a winner is picked; from `selected` on it is an agreement. */
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
  // A picked entrant continues under an agreement: bond, budget, fund, finalize, like hire-first.
  selected: ['accepted'],
  // No cancel edge: a published contest ends only through selection or expiry (R16-02).
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

/**
 * "Silence is acceptance" belongs to an agreement, not to the task's discovery mode (R16-03): a selected
 * contest winner who accepted and was funded has exactly the rights of a hired worker, matching
 * `JobsEvaluator.completeAfterSilence`. Unselected contest entrants have no agreement and no such right.
 * @param agreement The worker's agreement, or undefined for an entrant who was never selected.
 * @param status The task's current status.
 */
export function silenceIsAcceptance(agreement: Agreement | undefined, status: TaskStatus): boolean {
  return agreement !== undefined && status === 'finalized'
}

// -------------------------------------------------------------------------------------------------
// Projects, roles, membership, eligibility
// -------------------------------------------------------------------------------------------------

/** A project-defined role name. Nothing is fixed: developer, reviewer, security-reviewer are examples. */
export interface Role {
  name: string
}

/** A persistent owner of work: context, members, roles, defaults, budget. */
export interface Project {
  projectId: string
  name: string
  /** The wallet that publishes on-chain for this project and signs membership changes. */
  controller: Hex
  roles: readonly Role[]
  /** Defaults a new offer is resolved from, once, at publish. Never read again after that. */
  defaults: OfferDefaults
  policyVersion: number
}

/**
 * Where an agent's eligibility for a role may come from (R16-04). Three distinct facts:
 * - `declared`: the agent's own claim in ERC-8004 metadata. Anyone can say anything.
 * - `membership`: this project appointed the agent (project-scoped, revocable, may be its own agent).
 * - `endorsement`: ERC-8004 feedback from the project's controller. The registry forbids self-feedback,
 *   so a controller cannot endorse an agent it owns; that is what membership is for.
 */
export type EligibilitySource = 'declared' | 'membership' | 'endorsement' | 'membership-or-endorsement'

export interface EligibilityPolicy {
  role: string
  source: EligibilitySource
}

/** A project's appointment of an agent to a role. Revocation affects new admissions only. */
export interface Membership {
  projectId: string
  agentId: bigint
  role: string
  grantedAt: number
  revokedAt?: number
}

/** What is known about an agent for eligibility. Read from ERC-8004 and the board's membership table. */
export interface AgentRoleView {
  agentId: bigint
  /** Self-declared, from the identity registry metadata key `agent-jobs.roles`. */
  declared: readonly string[]
  /** Endorsements from reputation feedback with `tag1 = "role"`: role name → endorsing client addresses. */
  endorsedBy: Readonly<Record<string, readonly Hex[]>>
  memberships: readonly Membership[]
}

export const ROLES_METADATA_KEY = 'agent-jobs.roles'
export const ROLE_FEEDBACK_TAG = 'role'

/**
 * @param value The raw metadata bytes decoded as UTF-8.
 * @returns The declared role names, trimmed, lower-cased, de-duplicated.
 */
export function parseDeclaredRoles(value: string): string[] {
  return [...new Set(value.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean))]
}

export type RoleGateOutcome =
  | { admitted: true; reason: 'no-role-required' | 'declared' | 'member' | 'endorsed' }
  | { admitted: false; reason: 'unknown-role' | 'not-declared' | 'not-member' | 'not-endorsed' }

/**
 * Whether an agent may apply to or claim an offer. Membership is looked up by `projectId`, never by
 * controller, so two projects sharing a controller stay separate. An endorsement-required policy is never
 * satisfied by membership.
 * @param policy The offer's eligibility policy, or undefined for an open offer.
 * @param project The project that defines the role.
 * @param agent The agent's declarations, endorsements and memberships.
 * @param now Seconds; a membership revoked at or before `now` does not admit.
 */
export function roleGate(
  policy: EligibilityPolicy | undefined,
  project: Project | undefined,
  agent: AgentRoleView,
  now: number,
): RoleGateOutcome {
  if (!policy) return { admitted: true, reason: 'no-role-required' }
  if (!project || !project.roles.some((r) => r.name === policy.role)) return { admitted: false, reason: 'unknown-role' }

  const member = agent.memberships.some(
    (m) =>
      m.projectId === project.projectId &&
      m.agentId === agent.agentId &&
      m.role === policy.role &&
      m.grantedAt <= now &&
      (m.revokedAt === undefined || m.revokedAt > now),
  )
  const endorsed = (agent.endorsedBy[policy.role] ?? []).some(
    (c) => c.toLowerCase() === project.controller.toLowerCase(),
  )

  switch (policy.source) {
    case 'declared':
      return agent.declared.includes(policy.role)
        ? { admitted: true, reason: 'declared' }
        : { admitted: false, reason: 'not-declared' }
    case 'membership':
      return member ? { admitted: true, reason: 'member' } : { admitted: false, reason: 'not-member' }
    case 'endorsement':
      return endorsed ? { admitted: true, reason: 'endorsed' } : { admitted: false, reason: 'not-endorsed' }
    case 'membership-or-endorsement':
      if (member) return { admitted: true, reason: 'member' }
      return endorsed ? { admitted: true, reason: 'endorsed' } : { admitted: false, reason: 'not-member' }
  }
}

// -------------------------------------------------------------------------------------------------
// Offers and agreements (R16-05)
// -------------------------------------------------------------------------------------------------

/** Named CI checks and the trusted producer an evidence attestation must cover. */
export interface EvidencePolicy {
  checks: readonly string[]
  trustedProducer: string
  workflowPath: string
}

/** The windows the deployed `JobsEvaluator` enforces. Offers cannot choose others. */
export interface EvaluatorWindows {
  reviewSeconds: number
  disputeSeconds: number
  arbitrationSeconds: number
}

export interface OfferDefaults {
  token: Hex
  creatorBond: bigint
  workerBond: bigint
  windows: EvaluatorWindows
  evidencePolicy?: EvidencePolicy
}

/** A task: something that needs doing. Not yet an offer, not yet an agreement. */
export interface Task {
  taskId: string
  mode: TaskMode
  projectId?: string
  eligibility?: EligibilityPolicy
  status: TaskStatus
}

/**
 * The frozen, published terms of one task. Everything a worker accepts is here, resolved once at publish.
 * Its `termsHash` is the `policyHash` stored on the on-chain listing, which evidence must name.
 */
export interface OfferTerms {
  v: 1
  taskId: string
  projectId: string | null
  policyVersion: number | null
  mode: TaskMode
  token: Hex
  reward: bigint
  creatorBond: bigint
  workerBond: bigint
  windows: EvaluatorWindows
  eligibility: EligibilityPolicy | null
  evidencePolicy: EvidencePolicy | null
}

/** Canonical JSON: keys sorted at every level, bigints as decimal strings, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** keccak256 of the canonical JSON; equal to the listing's on-chain `policyHash`. */
export function termsHash(offer: OfferTerms): Hex {
  return keccak256(stringToHex(canonicalJson(offer)))
}

export class TermsError extends Error {
  constructor(readonly code: 'windows-mismatch' | 'listing-mismatch' | 'terms-hash-mismatch', message: string) {
    super(message)
  }
}

/**
 * Resolves a task and its project's current defaults into the frozen offer, once. Later project edits
 * never reach it. Rejects windows the deployed evaluator does not enforce.
 */
export function publishOffer(
  task: Task,
  project: Project | undefined,
  reward: bigint,
  standalone: OfferDefaults | undefined,
  evaluator: EvaluatorWindows,
): { offer: OfferTerms; termsHash: Hex } {
  const defaults = project?.defaults ?? standalone
  if (!defaults) throw new TermsError('listing-mismatch', 'A standalone task needs explicit defaults.')
  if (canonicalJson(defaults.windows) !== canonicalJson(evaluator)) {
    throw new TermsError('windows-mismatch', 'Offer windows must equal the deployed evaluator windows.')
  }
  const offer: OfferTerms = {
    v: 1,
    taskId: task.taskId,
    projectId: project?.projectId ?? null,
    policyVersion: project?.policyVersion ?? null,
    mode: task.mode,
    token: defaults.token,
    reward,
    creatorBond: defaults.creatorBond,
    workerBond: defaults.workerBond,
    windows: structuredClone(defaults.windows),
    eligibility: task.eligibility ? structuredClone(task.eligibility) : null,
    evidencePolicy: defaults.evidencePolicy ? structuredClone(defaults.evidencePolicy) : null,
  }
  return { offer, termsHash: termsHash(offer) }
}

/** What Holding's `listings(jobId)` reports, reduced to what the agreement must equal. */
export interface OnChainListing {
  token: Hex
  reward: bigint
  creatorBond: bigint
  workerBond: bigint
  policyHash: Hex
}

/** A worker's agreement: one frozen offer, one on-chain job. Nothing here changes after acceptance. */
export interface Agreement {
  agreementId: string
  jobId: bigint
  worker: Hex
  agentId: bigint
  terms: OfferTerms
  termsHash: Hex
}

/**
 * Pins the exact published offer to the worker and the job. Fails when the listing on-chain does not carry the
 * same asset, amounts and policy hash, so the board can never promise terms the contracts will not honour.
 */
export function pinAgreement(
  input: { agreementId: string; jobId: bigint; worker: Hex; agentId: bigint },
  published: { offer: OfferTerms; termsHash: Hex },
  listing: OnChainListing,
): Agreement {
  const offer = published.offer
  if (termsHash(offer) !== published.termsHash) {
    throw new TermsError('terms-hash-mismatch', 'The offer does not hash to its published termsHash.')
  }
  const same =
    listing.token.toLowerCase() === offer.token.toLowerCase() &&
    listing.reward === offer.reward &&
    listing.creatorBond === offer.creatorBond &&
    listing.workerBond === offer.workerBond &&
    listing.policyHash.toLowerCase() === published.termsHash.toLowerCase()
  if (!same) throw new TermsError('listing-mismatch', 'The on-chain listing does not match the published offer.')
  return { ...input, terms: structuredClone(offer), termsHash: published.termsHash }
}
