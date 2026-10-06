import { createHash, generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateDevAuthority } from './dev-authority.mjs'
const key = () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return { privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
}
function fixture() {
  const fresh = key(), old = key()
  const state = { version: 2, adminPublicKey: 'admin-public-key', verifiedAt: '2026-10-06T06:00:00Z', appId: 'cmui9skoc01zr0dl03tyahirs', adminId: 'admin', legacyPolicyId: 'legacy-policy', legacySignerId: 'legacy-routine',
    routine: { id: 'fresh-routine' }, policy: { id: 'fresh-policy' }, routinePrivateKey: fresh.privateKey, routinePublicKey: fresh.publicKey, legacySignerPublicKey: old.publicKey,
    originalAppSecretSha256: createHash('sha256').update('old-secret').digest('hex'), legacyPolicySha256: 'a'.repeat(64), desiredPolicySha256: 'b'.repeat(64) }
  const overlay = { PRIVY_APP_ID: state.appId, PRIVY_SIGNER_ID: 'fresh-routine', PRIVY_POLICY_ID: 'fresh-policy', PRIVY_SIGNER_KEY: fresh.privateKey }
  const env = { PRIVY_APP_ID: state.appId, PRIVY_APP_SECRET: 'replacement-secret', PRIVY_SIGNER_ID: 'legacy-routine', PRIVY_POLICY_ID: 'legacy-policy', PRIVY_POLICY_ADMIN_ID: 'admin', PRIVY_SIGNER_KEY: old.privateKey }
  return { state, overlay, env }
}
test('dev-only authority overlays fresh IDs and key without modifying retained legacy configuration', () => {
  const f = fixture(), original = structuredClone(f.env)
  assert.deepEqual(validateDevAuthority(f.state, f.overlay, f.env), f.overlay)
  assert.deepEqual(f.env, original)
})
test('unverified or changed authority cannot enter a dev deployment', () => {
  for (const change of [f => { delete f.state.verifiedAt }, f => { f.state.routine.id = 'legacy-routine' }, f => { f.state.policy.id = 'legacy-policy' }, f => { f.env.PRIVY_APP_SECRET = 'old-secret' },
    f => { f.overlay.PRIVY_SIGNER_KEY = f.env.PRIVY_SIGNER_KEY }, f => { f.overlay.EXTRA_BINDING = 'x' }, f => { f.env.PRIVY_APP_ID = 'other-app' }, f => { f.state.adminId = 'other-admin' },
    f => { f.overlay.PRIVY_POLICY_ID = 'other-policy' }, f => { f.state.routinePublicKey = 'changed' }, f => { f.state.legacyPolicySha256 = '' }, f => { delete f.state.originalAppSecretSha256 }, f => { f.state.originalAppSecretSha256 = 'invalid' }, f => { delete f.state.adminPublicKey }]) {
    const f = fixture(); change(f)
    assert.throws(() => validateDevAuthority(f.state, f.overlay, f.env), /sidequest-dev-authority-missing-or-drifted/)
  }
})
