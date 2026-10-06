/** Load only the privately journaled, verified Sidequest dev authority. Never modify legacy entries. */
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
const fields = ['PRIVY_APP_ID', 'PRIVY_SIGNER_ID', 'PRIVY_POLICY_ID', 'PRIVY_SIGNER_KEY']
const hash = value => createHash('sha256').update(value).digest('hex')
const refuse = () => { throw new Error('sidequest-dev-authority-missing-or-drifted') }
const publicKey = privateKey => createPublicKey(createPrivateKey({ key: Buffer.from(privateKey.replace(/^wallet-auth:/, ''), 'base64'), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).toString('base64')
export function validateDevAuthority(state, overlay, localEnv) {
  if (Object.keys(overlay).length !== fields.length || fields.some(field => !overlay[field]) || Object.keys(overlay).some(field => !fields.includes(field))) refuse()
  if (state.version !== 2 || !state.verifiedAt || state.appId !== 'cmui9skoc01zr0dl03tyahirs' || state.appId !== localEnv.PRIVY_APP_ID || overlay.PRIVY_APP_ID !== state.appId ||
      typeof state.adminPublicKey !== 'string' || !state.adminPublicKey ||
      state.adminId !== localEnv.PRIVY_POLICY_ADMIN_ID || state.legacyPolicyId !== localEnv.PRIVY_POLICY_ID || state.legacySignerId !== localEnv.PRIVY_SIGNER_ID ||
      !state.routine?.id || !state.policy?.id || state.routine.id === state.legacySignerId || state.routine.id === state.adminId || state.policy.id === state.legacyPolicyId ||
      overlay.PRIVY_SIGNER_ID !== state.routine.id || overlay.PRIVY_POLICY_ID !== state.policy.id || overlay.PRIVY_SIGNER_KEY !== state.routinePrivateKey ||
      !localEnv.PRIVY_APP_SECRET || hash(localEnv.PRIVY_APP_SECRET) === state.originalAppSecretSha256 ||
      !/^[a-f0-9]{64}$/.test(state.originalAppSecretSha256 ?? '') || !/^[a-f0-9]{64}$/.test(state.legacyPolicySha256 ?? '') || !/^[a-f0-9]{64}$/.test(state.desiredPolicySha256 ?? '')) refuse()
  try {
    if (publicKey(overlay.PRIVY_SIGNER_KEY) !== state.routinePublicKey || publicKey(localEnv.PRIVY_SIGNER_KEY) !== state.legacySignerPublicKey || state.routinePublicKey === state.legacySignerPublicKey) refuse()
  } catch { refuse() }
  return { ...overlay }
}
export function loadDevAuthority(repo, localEnv) {
  try {
    const state = JSON.parse(readFileSync(resolve(repo, '.sidequest/privy-cutover.json'), 'utf8'))
    const overlay = parseEnv(readFileSync(resolve(repo, '.sidequest/privy-dev.env'), 'utf8'))
    return validateDevAuthority(state, overlay, localEnv)
  } catch { throw new Error('sidequest-dev-authority-missing-or-drifted') }
}
