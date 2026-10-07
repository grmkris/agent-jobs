/**
 * Testnet deploy wrapper for one Sidequest generation. Run from the repository root of the checkout that holds
 * `.env.local` and `.sidequest/` (ignored, private):
 *
 *   node scripts/sidequest/contracts.mjs archive --generation g1d       # copy and reset the config; sends nothing
 *   node scripts/sidequest/contracts.mjs deploy-plan --generation g1d   # forge simulation; sends nothing
 *   SIDEQUEST_TESTNET_SEND=1 node scripts/sidequest/contracts.mjs deploy --generation g1d
 *   node scripts/sidequest/contracts.mjs promote --generation g1d       # verifies the candidate, writes the config
 *   node scripts/sidequest/contracts.mjs accept-plan --generation g1d
 *   SIDEQUEST_TESTNET_SEND=1 node scripts/sidequest/contracts.mjs accept --generation g1d
 *   node scripts/sidequest/contracts.mjs verify --generation g1d
 *
 * Signing keys come from `DEPLOYER_PRIVATE_KEY` / `SAFE_OWNER_PRIVATE_KEY` and are written once into encrypted
 * keystores under `.sidequest/keystores/`; forge reads only the keystore. Forge output goes to a private log, never
 * to the terminal. A partial broadcast must be finished with forge's `--resume`, never started again.
 */
import { randomBytes, randomUUID, createCipheriv, scryptSync } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { keccak256, concatHex, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { loadEnv } from './transaction.mjs'
import {
  archivePath,
  candidatePath,
  LOCKED_OPERATIONS,
  operationLockPath,
  parseArgs,
  planAction,
  resetConfig,
  roleFor,
} from './contracts-model.mjs'

const CONFIG = 'contracts/config/monad-testnet.json'

function keystore(env, root, role) {
  const key = env[`${role}_PRIVATE_KEY`]
  if (!key) throw new Error('signing-key-missing')
  const account = privateKeyToAccount(key)
  const directory = resolve(root, 'keystores')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = resolve(directory, role.toLowerCase() + '.json')
  const passwordPath = resolve(directory, role.toLowerCase() + '.password')
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8'))
    if (existing.address !== account.address.slice(2).toLowerCase() || !existsSync(passwordPath))
      throw new Error('keystore-drift')
    if (!existing.id) writeFileSync(path, JSON.stringify({ ...existing, id: randomUUID() }), { mode: 0o600 })
    return { path, passwordPath, address: account.address }
  }
  const password = randomBytes(32).toString('hex')
  const salt = randomBytes(32)
  const iv = randomBytes(16)
  const derived = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 })
  const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv)
  const encrypted = Buffer.concat([cipher.update(Buffer.from(key.slice(2), 'hex')), cipher.final()])
  const crypt = {
    cipher: 'aes-128-ctr',
    ciphertext: encrypted.toString('hex'),
    cipherparams: { iv: iv.toString('hex') },
    kdf: 'scrypt',
    kdfparams: { dklen: 32, n: 16384, r: 8, p: 1, salt: salt.toString('hex') },
    mac: keccak256(concatHex([toHex(derived.subarray(16)), toHex(encrypted)])).slice(2),
  }
  writeFileSync(passwordPath, password + '\n', { flag: 'wx', mode: 0o600 })
  writeFileSync(
    path,
    JSON.stringify({ version: 3, id: randomUUID(), address: account.address.slice(2).toLowerCase(), crypto: crypt }),
    {
      flag: 'wx',
      mode: 0o600,
    },
  )
  return { path, passwordPath, address: account.address }
}

export function archive(generation, configPath = CONFIG, target = resolve(archivePath(generation))) {
  const bytes = readFileSync(configPath)
  const config = JSON.parse(bytes.toString('utf8'))
  const reset = resetConfig(config)
  try {
    writeFileSync(target, bytes, { flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('archive-exists-reconcile-before-resume', { cause: error })
    throw error
  }
  writeFileSync(configPath, JSON.stringify(reset, null, 2) + '\n')
  console.log(
    JSON.stringify({
      action: 'archive',
      generation,
      archived: archivePath(generation),
      deploymentKeys: Object.keys(reset.deployment),
    }),
  )
}

const interrupted = () => process.exit(130)
const terminated = () => process.exit(143)

/** The lock is deliberately never stolen: an operator removes a stale lock by hand after reconciliation. */
export function withOperationLock(generation, operation, root = resolve('.sidequest')) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const lockPath = resolve(root, basename(operationLockPath(generation)))
  let fd
  try {
    fd = openSync(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`operation-in-progress ${lockPath}`, { cause: error })
    throw error
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    closeSync(fd)
    try {
      unlinkSync(lockPath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  process.once('exit', release)
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', terminated)
  try {
    writeFileSync(fd, String(process.pid) + '\n')
    return operation()
  } finally {
    process.removeListener('exit', release)
    process.removeListener('SIGINT', interrupted)
    process.removeListener('SIGTERM', terminated)
    release()
  }
}

function run(action, generation) {
  const env = loadEnv()
  const root = resolve('.sidequest')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'))
  const plan = planAction({
    action,
    generation,
    config,
    env,
    candidateExists: existsSync(resolve(candidatePath(generation))),
    signer: keystore(env, root, roleFor(action)),
  })
  const logName = `contracts-${generation}-${action}.log`
  const log = openSync(resolve(root, logName), 'a', 0o600)
  const result = spawnSync('forge', plan.args, {
    cwd: resolve('contracts'),
    env: { ...env, ...plan.forgeEnv },
    stdio: ['ignore', log, log],
  })
  closeSync(log)
  console.log(
    JSON.stringify({
      action,
      generation,
      sends: plan.sends,
      exitCode: result.status,
      privateLog: `.sidequest/${logName}`,
    }),
  )
  if (result.status !== 0) process.exitCode = 1
}

function main() {
  const { action, generation } = parseArgs(process.argv.slice(2))
  const operation = () => (action === 'archive' ? archive(generation) : run(action, generation))
  if (LOCKED_OPERATIONS.has(action)) withOperationLock(generation, operation)
  else operation()
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  try {
    main()
  } catch (error) {
    console.error(
      error instanceof Error &&
        (/^[a-z0-9-]+$/.test(error.message) || error.message.startsWith('operation-in-progress '))
        ? error.message
        : 'contract-operation-failed-inspect-private-log',
    )
    process.exitCode = 1
  }
