import assert from 'node:assert/strict'
import test from 'node:test'
import { readApprovedChanges, validatePlanChanges } from './approved-changes.mjs'

const reference = readApprovedChanges().reference
const empty = { migrations: [], secretChanges: [], resourceCreates: [], domainChanges: [], scheduleChanges: [] }

test('an unlisted secret is refused', () => {
  const result = validatePlanChanges({ ...empty, secretChanges: [{ logicalId: 'Api', name: 'DATABASE_PASSWORD', action: 'add' }] }, reference)
  assert.equal(result.ok, false)
  assert.ok(result.blockers.includes('unapproved-additive-or-config-change'))
})

test('a tampered manifest digest is refused', () => {
  const result = validatePlanChanges({ ...empty, secretChanges: [{ logicalId: 'Api', name: 'RELAY_PRIVATE_KEY', action: 'rotate' }] }, { ...reference, sha256: '0'.repeat(64) })
  assert.equal(result.ok, false)
  assert.ok(result.blockers.includes('approved-change-manifest-mismatch'))
})

test('a listed rotation is allowed', () => {
  const result = validatePlanChanges({ ...empty, secretChanges: [{ logicalId: 'Api', name: 'RELAY_PRIVATE_KEY', action: 'rotate' }] }, reference)
  assert.deepEqual(result, { ok: true, blockers: [] })
})

test('the additional exposed credentials may rotate only on their named Worker', () => {
  const secretChanges = [
    { logicalId: 'Api', name: 'AI_GATEWAY_API_KEY', action: 'rotate' },
    { logicalId: 'Api', name: 'GITHUB_APP_PRIVATE_KEY', action: 'rotate' },
    { logicalId: 'Indexer', name: 'HYPERSYNC_API_TOKEN', action: 'rotate' },
  ]
  assert.deepEqual(validatePlanChanges({ ...empty, secretChanges }, reference), { ok: true, blockers: [] })
  for (const change of secretChanges) {
    assert.equal(validatePlanChanges({ ...empty, secretChanges: [{ ...change, action: 'add' }] }, reference).ok, false)
    assert.equal(validatePlanChanges({ ...empty, secretChanges: [{ ...change, logicalId: change.logicalId === 'Api' ? 'Indexer' : 'Api' }] }, reference).ok, false)
  }
  assert.equal(validatePlanChanges({ ...empty, secretChanges: [...secretChanges, { logicalId: 'Api', name: 'MONAD_RPC_URL', action: 'rotate' }] }, reference).ok, false)
})

test('a migration is still refused with an otherwise listed change', () => {
  const result = validatePlanChanges({ ...empty, migrations: ['0002'], secretChanges: [{ logicalId: 'Api', name: 'ATTESTER_PRIVATE_KEY', action: 'rotate' }] }, reference)
  assert.equal(result.ok, false)
  assert.ok(result.blockers.includes('unapproved-additive-or-config-change'))
})
