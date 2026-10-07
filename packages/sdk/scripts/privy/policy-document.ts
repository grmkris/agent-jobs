/** Strict comparison of provider policy documents for v1 authority operations. */
import { formatPrivyAuthorizationPayload } from '../../src/privy.ts'
type JsonRecord = Record<string, unknown>
export class PolicyDocumentError extends Error {}
function record(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PolicyDocumentError('Invalid policy structure; refusing update')
  }
  return value as JsonRecord
}

export function writablePolicy(policy: JsonRecord): JsonRecord {
  const fields = new Set(['id', 'created_at', 'version', 'name', 'chain_type', 'owner_id', 'rules'])
  if (Object.keys(policy).some((field) => !fields.has(field)) || !Array.isArray(policy.rules)) {
    throw new PolicyDocumentError('Unexpected policy fields; refusing update')
  }
  const { id: _id, created_at: _createdAt, ...body } = policy
  return {
    ...body,
    rules: policy.rules.map((value) => {
      const { id: _ruleId, ...rule } = record(structuredClone(value))
      return rule
    }),
  }
}

export function canonical(policy: JsonRecord): string {
  return formatPrivyAuthorizationPayload({ method: 'PATCH', url: '', headers: {}, body: policy })
}
