/** Frozen policy comparison used by the retained v1 authority cutover. */
import { createHash } from 'node:crypto'
import { isAddress, zeroAddress } from 'viem'
import { authorityPolicy } from './policy.ts'
import { canonical, writablePolicy } from './policy-document.ts'
type JsonRecord = Record<string, unknown>
type AuthorityPolicy = ReturnType<typeof authorityPolicy>
export interface ArchivedPins { holding: string; core: string; relay: string }
export class SidequestPolicyPlanError extends Error {}

function record(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SidequestPolicyPlanError('Invalid policy structure; refusing plan')
  }
  return value as JsonRecord
}

function address(value: unknown): string {
  if (typeof value !== 'string' || !isAddress(value) || value.toLowerCase() === zeroAddress) {
    throw new SidequestPolicyPlanError('Invalid deployment pin; refusing plan')
  }
  return value
}

function pinned(policy: JsonRecord, ruleName: string, source: string, field: string): JsonRecord {
  if (!Array.isArray(policy.rules)) throw new SidequestPolicyPlanError('Invalid policy rules; refusing plan')
  const rules = policy.rules.map(record).filter(rule => rule.name === ruleName)
  if (rules.length !== 1 || !Array.isArray(rules[0]!.conditions)) {
    throw new SidequestPolicyPlanError('Expected one pinned rule; refusing plan')
  }
  const conditions = rules[0]!.conditions.map(record).filter(condition =>
    condition.field_source === source && condition.field === field)
  if (conditions.length !== 1 || conditions[0]!.operator !== 'eq') {
    throw new SidequestPolicyPlanError('Expected one equality pin; refusing plan')
  }
  return conditions[0]!
}

/** Permit exactly the archived-to-fresh name and four pins; retain every rule, schema, bound and owner. */
export function sidequestPolicyPlan(live: JsonRecord, desired: AuthorityPolicy, archived: ArchivedPins) {
  if (typeof live.id !== 'string' || !live.id || desired.name !== 'Sidequest v2 Monad testnet routine signer') {
    throw new SidequestPolicyPlanError('Missing legacy policy ID or incorrect Sidequest name; refusing plan')
  }
  const before = writablePolicy(live)
  const expected = structuredClone(desired) as JsonRecord
  expected.name = 'Hireling v2 Monad testnet routine signer'
  const changes: { rule: string; field: string; before: string; after: string }[] = []
  for (const [rule, source, field, oldValue] of [
    ['Allow Selection', 'ethereum_typed_data_domain', 'verifyingContract', archived.holding],
    ['Allow SetBudgetAuthorization', 'ethereum_typed_data_domain', 'verifyingContract', archived.core],
    ['Allow SubmitAuthorization', 'ethereum_typed_data_domain', 'verifyingContract', archived.core],
    ['Allow Delegation', 'ethereum_typed_data_message', 'delegate', archived.relay],
  ]) {
    const old = address(oldValue)
    const current = pinned(before, rule!, source!, field!)
    const next = pinned(expected, rule!, source!, field!)
    const promoted = address(next.value)
    if (old.toLowerCase() === promoted.toLowerCase()) throw new SidequestPolicyPlanError('Expected fresh deployment pins; refusing plan')
    if (address(current.value).toLowerCase() !== old.toLowerCase()) {
      throw new SidequestPolicyPlanError('Live policy is not the archived deployment; refusing plan')
    }
    current.value = old
    next.value = old
    changes.push({ rule: rule!, field: field!, before: old, after: promoted })
  }
  if (canonical(before) !== canonical(expected)) {
    throw new SidequestPolicyPlanError('Policy drift beyond the Sidequest name and four pins; refusing plan')
  }
  return {
    legacyPolicyId: live.id,
    legacyPolicySha256: createHash('sha256').update(canonical(writablePolicy(live))).digest('hex'),
    legacyPolicyUnchanged: true,
    action: 'create-separate-policy' as const,
    changes,
    create: structuredClone(desired),
  }
}

