/**
 * Projects, roles and eligibility (spec §1 "Projects and roles", R16-04). Pure functions over plain values.
 */
import type { Hex } from 'viem'
import type { OfferDefaults } from './terms.ts'

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
  /** Self-declared, from the identity registry metadata key `sidequest.roles`. */
  declared: readonly string[]
  /** Endorsements from reputation feedback with `tag1 = "role"`: role name → endorsing client addresses. */
  endorsedBy: Readonly<Record<string, readonly Hex[]>>
  memberships: readonly Membership[]
}

export const ROLES_METADATA_KEY = 'sidequest.roles'
export const ROLE_FEEDBACK_TAG = 'role'

/**
 * @param value The raw metadata bytes decoded as UTF-8.
 * @returns The declared role names, trimmed, lower-cased, de-duplicated.
 */
export function parseDeclaredRoles(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
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
