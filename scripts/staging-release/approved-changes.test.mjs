import assert from 'node:assert/strict'
import test from 'node:test'
import { readApprovedChanges, settingAddition, validateManifestShape, validatePlanChanges } from './approved-changes.mjs'

const reference = readApprovedChanges().reference
const empty = { migrations: [], secretChanges: [], settingsChanges: [], resourceCreates: [], domainChanges: [], scheduleChanges: [] }

test('applied Privy settings are absent while the historical setting allowlist remains strict', () => {
  const { manifest } = readApprovedChanges()
  assert.equal(validateManifestShape(manifest), true)
  assert.deepEqual(manifest.settingsChanges, [])
  const historicalSettings = [
    { logicalId: 'Api', name: 'PRIVY_APP_ID', action: 'add', type: 'plain_text' },
    { logicalId: 'Api', name: 'PRIVY_SIGNER_ID', action: 'add', type: 'plain_text' },
    { logicalId: 'Api', name: 'PRIVY_POLICY_ID', action: 'add', type: 'plain_text' },
  ]
  assert.deepEqual(validatePlanChanges({ ...empty, settingsChanges: manifest.settingsChanges }, reference), { ok: true, blockers: [] })
  for (const settingsChanges of [historicalSettings, ...historicalSettings.map(change => [change])]) {
    assert.equal(validateManifestShape({ ...manifest, settingsChanges }), true)
    assert.equal(validatePlanChanges({ ...empty, settingsChanges }, reference).ok, false)
  }
  for (const patch of [
    { name: 'PRIVY_APP_SECRET' }, { name: 'UNLISTED_SETTING' }, { logicalId: 'Indexer' },
    { action: 'rotate' }, { type: 'json' }, { type: 'secret_text' }, { value: '' }, { text: 'untrusted-marker' },
  ]) {
    const invalid = { ...structuredClone(manifest), settingsChanges: structuredClone(historicalSettings) }
    Object.assign(invalid.settingsChanges[0], patch)
    assert.equal(validateManifestShape(invalid), false)
    assert.equal(validatePlanChanges({ ...empty, settingsChanges: invalid.settingsChanges }, reference).ok, false)
  }
  for (const settingsChanges of [[...historicalSettings, historicalSettings[0]], [historicalSettings[0], historicalSettings[0], historicalSettings[2]]]) {
    assert.equal(validateManifestShape({ ...manifest, settingsChanges }), false)
  }
  assert.equal(validatePlanChanges({ ...empty, settingsChanges: historicalSettings }, undefined).ok, false)
})

test('settings validation checks the wire type and a nonempty value without returning its value', () => {
  for (const name of ['PRIVY_APP_ID', 'PRIVY_SIGNER_ID', 'PRIVY_POLICY_ID']) {
    const wire = { name, type: 'plain_text', text: 'untrusted-marker' }
    assert.deepEqual(settingAddition('Api', wire), { logicalId: 'Api', name, type: 'plain_text', action: 'add' })
    for (const text of ['', ' \t\n', undefined, null, 1, {}, []]) assert.equal(settingAddition('Api', { ...wire, text }), undefined)
    for (const type of ['secret_text', 'inherit', 'json']) assert.equal(settingAddition('Api', { ...wire, type }), undefined)
    assert.equal(settingAddition('Indexer', wire), undefined)
    assert.equal(settingAddition('Api', { ...wire, name: 'UNLISTED_SETTING' }), undefined)
  }
})

test('an unlisted secret is refused', () => {
  const result = validatePlanChanges({ ...empty, secretChanges: [{ logicalId: 'Api', name: 'DATABASE_PASSWORD', action: 'add' }] }, reference)
  assert.equal(result.ok, false)
  assert.ok(result.blockers.includes('unapproved-additive-or-config-change'))
})

test('a tampered manifest digest is refused', () => {
  const result = validatePlanChanges({ ...empty, secretChanges: [{ logicalId: 'Api', name: 'ATTESTER_PRIVATE_KEY', action: 'rotate' }] }, { ...reference, sha256: '0'.repeat(64) })
  assert.equal(result.ok, false)
  assert.ok(result.blockers.includes('approved-change-manifest-mismatch'))
})

test('a remaining listed rotation is allowed', () => {
  const result = validatePlanChanges({ ...empty, secretChanges: [{ logicalId: 'Api', name: 'ATTESTER_PRIVATE_KEY', action: 'rotate' }] }, reference)
  assert.deepEqual(result, { ok: true, blockers: [] })
})

test('the retired secret approvals are refused after release', () => {
  const change = { logicalId: 'Api', name: 'PRIVY_APP_SECRET', action: 'rotate' }
  for (const retired of [
    change,
    { logicalId: 'Api', name: 'PRIVY_SIGNER_KEY', action: 'add' },
    { logicalId: 'Api', name: 'RELAY_PRIVATE_KEY', action: 'rotate' },
    { logicalId: 'Api', name: 'TELEGRAM_BOT_TOKEN', action: 'add' },
    { logicalId: 'Api', name: 'TELEGRAM_WEBHOOK_SECRET', action: 'add' },
    { logicalId: 'Indexer', name: 'TELEGRAM_BOT_TOKEN', action: 'add' },
  ]) {
    assert.equal(validatePlanChanges({ ...empty, secretChanges: [retired] }, readApprovedChanges().reference).ok, false)
  }
  assert.equal(validatePlanChanges({ ...empty, secretChanges: [{ ...change, logicalId: 'Indexer' }] }, readApprovedChanges().reference).ok, false)
  assert.equal(validatePlanChanges({ ...empty, secretChanges: [{ ...change, action: 'add' }] }, readApprovedChanges().reference).ok, false)
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
