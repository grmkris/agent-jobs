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

test('a migration is still refused with an otherwise listed change', () => {
  const result = validatePlanChanges({ ...empty, migrations: ['0002'], secretChanges: [{ logicalId: 'Api', name: 'ATTESTER_PRIVATE_KEY', action: 'rotate' }] }, reference)
  assert.equal(result.ok, false)
  assert.ok(result.blockers.includes('unapproved-additive-or-config-change'))
})
