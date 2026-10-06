/** Read-only plan for a separate Sidequest policy. Never PATCH the legacy recovery policy. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAddress, zeroAddress } from 'viem'
import { PrivyApi } from './client.ts'
import { localEnv, required } from './env.ts'
import { authorityPolicy, config } from './policy.ts'
import { canonical, writablePolicy } from './update-holding.ts'

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

export async function planSidequestPolicy() {
  const archived = JSON.parse(readFileSync(new URL('../../../../contracts/config/archive/pre-sidequest-monad-testnet.json', import.meta.url), 'utf8'))
  if (archived.chainId !== 10143 || archived.deployment?.main?.kind !== 'hireling-v1' ||
      config.chainId !== 10143 || config.deployment?.main?.kind !== 'sidequest-v1' || config.sidequest?.reuseCore !== false) {
    throw new SidequestPolicyPlanError('Expected archived and fresh Monad testnet deployments; refusing plan')
  }
  const env = localEnv()
  const policyId = required(env, 'PRIVY_POLICY_ID')
  const api = new PrivyApi(required(env, 'PRIVY_APP_ID'), required(env, 'PRIVY_APP_SECRET'))
  const live = await api.checked('GET', `/policies/${policyId}`)
  if (live.id !== policyId) throw new SidequestPolicyPlanError('Unexpected policy ID; refusing plan')
  return {
    mode: 'read-only',
    observedAt: new Date().toISOString(),
    appId: required(env, 'PRIVY_APP_ID'),
    ...sidequestPolicyPlan(live, authorityPolicy(required(env, 'PRIVY_POLICY_ADMIN_ID')), {
      holding: archived.deployment.main.holding, core: archived.deployment.core, relay: archived.roles.relay,
    }),
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 2) throw new SidequestPolicyPlanError('Read-only planner takes no arguments; no apply mode')
    console.log(JSON.stringify(await planSidequestPolicy(), null, 2))
  } catch (error) {
    console.error(error instanceof SidequestPolicyPlanError ? error.message : 'Sidequest policy plan refused; provider response and credentials suppressed')
    process.exitCode = 1
  }
}
