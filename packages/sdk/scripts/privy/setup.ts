import { createPrivateKey, createPublicKey } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { PrivyApi, PrivyApiError } from './client.ts'
import { adminEnv, adminEnvPath, appendEnv, envPath, localEnv, required } from './env.ts'
import { generateAuthorizationKey } from '../../src/p256.ts'
import { authorityPolicy } from './policy.ts'
import { formatPrivyAuthorizationPayload } from '../../src/privy.ts'

const stateDirectory = new URL('./.local/', import.meta.url)
const statePath = new URL('setup.json', stateDirectory)

interface Creation {
  key: string
  startedAt: string
  id?: string
  rejected?: boolean
}

function saveState(state: Record<string, Creation>): void {
  const temporary = new URL('setup.json.tmp', stateDirectory)
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, statePath)
}

function publicAuthorizationKey(privateKey: string): string {
  const object = createPrivateKey({ key: Buffer.from(privateKey.replace(/^wallet-auth:/, ''), 'base64'), format: 'der', type: 'pkcs8' })
  return createPublicKey(object).export({ format: 'der', type: 'spki' }).toString('base64')
}

async function verifyQuorum(api: PrivyApi, id: string, publicKey: string, name: string): Promise<void> {
  const quorum = await api.checked('GET', `/key_quorums/${id}`)
  const keys = quorum.authorization_keys as { public_key: string }[]
  if (quorum.authorization_threshold !== 1 || keys?.length !== 1 || keys[0]?.public_key !== publicKey ||
      (quorum.user_ids as unknown[])?.length || (quorum.key_quorum_ids as unknown[])?.length) {
    throw new Error(`Unexpected ${name} quorum; refusing authority drift`)
  }
}

function canonicalPolicy(body: Record<string, unknown>): string {
  return formatPrivyAuthorizationPayload({ method: 'POST', url: '', headers: {}, body })
}

async function verifyPolicy(api: PrivyApi, id: string, adminId: string): Promise<void> {
  const desired = authorityPolicy(adminId)
  const policy = await api.checked('GET', `/policies/${id}`)
  const rules = (policy.rules as Record<string, unknown>[]).map(({ id: _id, ...rule }) => rule)
  if (policy.owner_id !== adminId || policy.chain_type !== desired.chain_type || canonicalPolicy({ rules }) !== canonicalPolicy({ rules: desired.rules })) {
    throw new Error('Policy drift; no automatic widening')
  }
}

/** Verification performs only GETs and never creates a key, quorum, policy or local setup state. */
export async function verifyAuthority(): Promise<{ signerId: string; adminId: string; policyId: string }> {
  const env = localEnv()
  const api = new PrivyApi(required(env, 'PRIVY_APP_ID'), required(env, 'PRIVY_APP_SECRET'))
  const signerId = required(env, 'PRIVY_SIGNER_ID')
  const adminId = required(env, 'PRIVY_POLICY_ADMIN_ID')
  const policyId = required(env, 'PRIVY_POLICY_ID')
  await verifyQuorum(api, signerId, publicAuthorizationKey(required(env, 'PRIVY_SIGNER_KEY')), 'routine')
  await verifyQuorum(api, adminId, publicAuthorizationKey(required(adminEnv(), 'PRIVY_POLICY_ADMIN_KEY')), 'policy-admin')
  await verifyPolicy(api, policyId, adminId)
  return { signerId, adminId, policyId }
}

export async function setup(): Promise<{ signerId: string; adminId: string; policyId: string }> {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
  const lock = new URL('setup.lock', stateDirectory)
  const descriptor = openSync(lock, 'wx', 0o600)
  try {
    const env = localEnv()
    const api = new PrivyApi(required(env, 'PRIVY_APP_ID'), required(env, 'PRIVY_APP_SECRET'))
    const state: Record<string, Creation> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}

    async function keyQuorum(name: string, keyName: string, path: string, secrets: Record<string, string>): Promise<string> {
      let privateKey = secrets[keyName]
      if (!privateKey) {
        privateKey = (await generateAuthorizationKey()).privateKey
        appendEnv(path, keyName, privateKey)
      }
      const publicKey = publicAuthorizationKey(privateKey)
      const idName = name === 'routine' ? 'PRIVY_SIGNER_ID' : 'PRIVY_POLICY_ADMIN_ID'
      let id = env[idName] ?? state[name]?.id
      if (!id) {
        // Quorum creation has no documented idempotency contract. Refuse an ambiguous replay.
        if (state[name]) throw new Error(`Unresolved ${name} quorum creation; reconcile in Privy before retrying`)
        state[name] = { key: crypto.randomUUID(), startedAt: new Date().toISOString() }
        saveState(state)
        const result = await api.checked('POST', '/key_quorums', {
          display_name: `Hireling v2 ${name} Monad testnet`, public_keys: [publicKey], authorization_threshold: 1,
        })
        id = required(result as Record<string, string>, 'id')
        state[name]!.id = id
        saveState(state)
      }
      await verifyQuorum(api, id, publicKey, name)
      appendEnv(envPath, idName, id)
      return id
    }

    const signerId = await keyQuorum('routine', 'PRIVY_SIGNER_KEY', envPath, env)
    const adminId = await keyQuorum('policy-admin', 'PRIVY_POLICY_ADMIN_KEY', adminEnvPath, adminEnv())
    const desired = authorityPolicy(adminId)
    let policyId = env.PRIVY_POLICY_ID ?? state.policy?.id
    if (!policyId) {
      if (state.policy && !state.policy.rejected) throw new Error('Unresolved policy creation; reconcile the original request before retrying')
      state.policy = { key: crypto.randomUUID(), startedAt: new Date().toISOString() }
      saveState(state)
      let result: Record<string, unknown>
      try {
        result = await api.checked('POST', '/policies', desired, undefined, state.policy.key)
      } catch (error) {
        // A confirmed validation rejection created nothing; network failures remain ambiguous.
        if (error instanceof PrivyApiError && error.status === 400) {
          state.policy.rejected = true
          saveState(state)
        }
        throw error
      }
      policyId = required(result as Record<string, string>, 'id')
      state.policy.id = policyId
      saveState(state)
    }
    await verifyPolicy(api, policyId, adminId)
    appendEnv(envPath, 'PRIVY_POLICY_ID', policyId)
    return { signerId, adminId, policyId }
  } finally {
    closeSync(descriptor)
    unlinkSync(lock)
  }
}

if (import.meta.main) {
  try {
    if (process.argv.slice(2).some(argument => argument !== '--verify')) throw new Error('Use setup.ts with no arguments or --verify')
    console.log(JSON.stringify(await (process.argv.includes('--verify') ? verifyAuthority() : setup())))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Privy setup failed; response suppressed')
    process.exitCode = 1
  }
}
