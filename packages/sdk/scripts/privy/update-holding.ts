import { readFileSync } from 'node:fs'
import { isAddress, zeroAddress } from 'viem'
import { p256AuthorizationSigner } from '../../src/p256.ts'
import { formatPrivyAuthorizationPayload } from '../../src/privy.ts'
import { PrivyApi, PrivyApiError } from './client.ts'
import { adminEnv, localEnv, required } from './env.ts'
import { authorityPolicy, config } from './policy.ts'
import { verifyAuthority } from './setup.ts'

type AuthorityPolicy = ReturnType<typeof authorityPolicy>
type JsonRecord = Record<string, unknown>

export class HoldingUpdateError extends Error {}

function record(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HoldingUpdateError('Invalid policy structure; refusing update')
  }
  return value as JsonRecord
}

function address(value: unknown): string {
  if (typeof value !== 'string' || !isAddress(value) || value.toLowerCase() === zeroAddress) {
    throw new HoldingUpdateError('Invalid Holding address; refusing update')
  }
  return value
}

export function writablePolicy(policy: JsonRecord): JsonRecord {
  const fields = new Set(['id', 'created_at', 'version', 'name', 'chain_type', 'owner_id', 'rules'])
  if (Object.keys(policy).some(field => !fields.has(field)) || !Array.isArray(policy.rules)) {
    throw new HoldingUpdateError('Unexpected policy fields; refusing update')
  }
  const { id: _id, created_at: _createdAt, ...body } = policy
  return {
    ...body,
    rules: policy.rules.map(value => {
      const { id: _ruleId, ...rule } = record(structuredClone(value))
      return rule
    }),
  }
}

function selectionContract(policy: JsonRecord): JsonRecord {
  if (!Array.isArray(policy.rules)) throw new HoldingUpdateError('Invalid policy rules; refusing update')
  const selections = policy.rules.map(record).filter(rule => {
    if (!Array.isArray(rule.conditions)) throw new HoldingUpdateError('Invalid rule conditions; refusing update')
    return rule.name === 'Allow Selection' && rule.method === 'eth_signTypedData_v4' &&
      rule.conditions.some(value => record(value).typed_data !== undefined &&
        record(record(value).typed_data).primary_type === 'Selection')
  })
  if (selections.length !== 1) throw new HoldingUpdateError('Expected exactly one Selection rule; refusing update')
  const conditions = selections[0]!.conditions as unknown[]
  const contracts = conditions.map(record).filter(condition =>
    condition.field_source === 'ethereum_typed_data_domain' && condition.field === 'verifyingContract')
  if (contracts.length !== 1 || contracts[0]!.operator !== 'eq') {
    throw new HoldingUpdateError('Expected one pinned Selection contract; refusing update')
  }
  return contracts[0]!
}

export function canonical(policy: JsonRecord): string {
  return formatPrivyAuthorizationPayload({ method: 'PATCH', url: '', headers: {}, body: policy })
}

/** Ignore provider IDs/timestamps only; permit exactly the archived-to-promoted Selection address change. */
export function holdingPolicyUpdate(live: JsonRecord, desired: AuthorityPolicy, archivedHolding: string) {
  const oldHolding = address(archivedHolding)
  const expected = structuredClone(desired) as JsonRecord
  const expectedContract = selectionContract(expected)
  const newHolding = address(expectedContract.value)
  if (oldHolding.toLowerCase() === newHolding.toLowerCase()) {
    throw new HoldingUpdateError('Holding has not changed; promote G1c before updating the policy')
  }
  const before = writablePolicy(live)
  const oldContract = selectionContract(before)
  if (address(oldContract.value).toLowerCase() !== oldHolding.toLowerCase()) {
    throw new HoldingUpdateError('Live Selection contract is not the archived G1b Holding; refusing update')
  }
  // Address casing is irrelevant, but every other field, condition and rule order must match exactly.
  oldContract.value = oldHolding
  expectedContract.value = oldHolding
  if (canonical(before) !== canonical(expected)) {
    throw new HoldingUpdateError('Policy drift beyond the Holding address; refusing update')
  }
  return { oldHolding, newHolding, rules: desired.rules }
}

export async function updateHolding(apply = false) {
  const archived = JSON.parse(readFileSync(new URL('../../../../contracts/config/archive/monad-testnet-g1b.json', import.meta.url), 'utf8'))
  if (archived.chainId !== 10143 || archived.deployment?.main?.kind !== 'hireling-v1' ||
      config.deployment?.main?.kind !== 'hireling-v1') {
    throw new HoldingUpdateError('Expected archived G1b and promoted testnet Hireling configs')
  }
  const env = localEnv()
  const api = new PrivyApi(required(env, 'PRIVY_APP_ID'), required(env, 'PRIVY_APP_SECRET'))
  const policyId = required(env, 'PRIVY_POLICY_ID')
  const adminId = required(env, 'PRIVY_POLICY_ADMIN_ID')
  const desired = authorityPolicy(adminId)
  const live = await api.checked('GET', `/policies/${policyId}`)
  if (live.id !== policyId) throw new HoldingUpdateError('Unexpected policy ID; refusing update')
  const { oldHolding, newHolding, rules } = holdingPolicyUpdate(live, desired, archived.deployment.main.holding)
  if (!apply) return { mode: 'dry-run', policyId, oldHolding, newHolding }

  const sign = await p256AuthorizationSigner(required(adminEnv(), 'PRIVY_POLICY_ADMIN_KEY'))
  await api.checked('PATCH', `/policies/${policyId}`, { rules }, sign)
  const verified = await verifyAuthority()
  if (verified.policyId !== policyId || verified.adminId !== adminId) {
    throw new HoldingUpdateError('Authority IDs changed during verification; reconcile the original policy')
  }
  return verified
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || args.length === 1 && args[0] !== '--yes') {
      throw new HoldingUpdateError('Use update-holding.ts with no arguments (dry-run) or --yes')
    }
    console.log(JSON.stringify(await updateHolding(args[0] === '--yes')))
  } catch (error) {
    console.error(error instanceof HoldingUpdateError || error instanceof PrivyApiError
      ? error.message : 'Privy Holding update failed; response and credentials suppressed')
    process.exitCode = 1
  }
}
