import { randomBytes, randomUUID, createCipheriv, scryptSync } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { keccak256, concatHex, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { loadEnv } from './transaction.mjs'

const env = loadEnv()
const action = process.argv[2]
const root = resolve('.sidequest')
mkdirSync(root, { recursive: true, mode: 0o700 })

function keystore(role) {
  const key = env[`${role}_PRIVATE_KEY`]
  const account = privateKeyToAccount(key)
  const directory = resolve(root, 'keystores')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = resolve(directory, role.toLowerCase() + '.json')
  const passwordPath = resolve(directory, role.toLowerCase() + '.password')
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8'))
    if (existing.address !== account.address.slice(2).toLowerCase() || !existsSync(passwordPath)) throw new Error('keystore-drift')
    if (!existing.id) writeFileSync(path, JSON.stringify({ ...existing, id: randomUUID() }), { mode: 0o600 })
    return { path, passwordPath, address: account.address }
  }
  const password = randomBytes(32).toString('hex')
  const salt = randomBytes(32), iv = randomBytes(16)
  const derived = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 })
  const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv)
  const encrypted = Buffer.concat([cipher.update(Buffer.from(key.slice(2), 'hex')), cipher.final()])
  const crypt = { cipher: 'aes-128-ctr', ciphertext: encrypted.toString('hex'), cipherparams: { iv: iv.toString('hex') }, kdf: 'scrypt', kdfparams: { dklen: 32, n: 16384, r: 8, p: 1, salt: salt.toString('hex') }, mac: keccak256(concatHex([toHex(derived.subarray(16)), toHex(encrypted)])).slice(2) }
  writeFileSync(passwordPath, password + '\n', { flag: 'wx', mode: 0o600 })
  writeFileSync(path, JSON.stringify({ version: 3, id: randomUUID(), address: account.address.slice(2).toLowerCase(), crypto: crypt }), { flag: 'wx', mode: 0o600 })
  return { path, passwordPath, address: account.address }
}

try {
  const config = JSON.parse(readFileSync('contracts/config/monad-testnet.json', 'utf8'))
  if (config.chainId !== 10143 || config.sidequest?.reuseCore === true) throw new Error('fresh-testnet-config-required')
  const sends = ['deploy', 'accept'].includes(action)
  if (sends && env.SIDEQUEST_TESTNET_SEND !== '1') throw new Error('testnet-send-not-enabled')
  const promoted = config.deployment.sidequest !== undefined
  const candidate = resolve('contracts/broadcast/sidequest-dev/sidequest/monad-testnet.candidate.json')
  if (action === 'deploy' && (promoted || existsSync(candidate))) throw new Error('deployment-already-started-reconcile-before-resume')
  const role = action?.startsWith('accept') ? 'SAFE_OWNER' : 'DEPLOYER'
  const signer = keystore(role)
  if (role === 'DEPLOYER' && signer.address !== config.roles.admin) throw new Error('deployer-config-mismatch')
  const scripts = { 'deploy-plan': 'DeploySidequest.s.sol', deploy: 'DeploySidequest.s.sol', promote: 'PromoteSidequest.s.sol', 'accept-plan': 'SafeAccept.s.sol', accept: 'SafeAccept.s.sol', verify: 'SafeAccept.s.sol' }
  if (!scripts[action]) throw new Error('invalid-contract-action')
  const args = ['script', `script/${scripts[action]}`, '--rpc-url', env.MONAD_RPC_URL, '--sender', signer.address]
  if (action === 'verify') args.push('--sig', 'check()')
  if (action !== 'promote' && action !== 'verify') args.push('--keystore', signer.path, '--password-file', signer.passwordPath, '--legacy', '--with-gas-price', '110000000000', '--gas-estimate-multiplier', '110')
  if (sends) args.push('--broadcast', '--slow', '--non-interactive')
  const logPath = resolve(root, `contracts-${action}.log`)
  const log = openSync(logPath, 'a', 0o600)
  const result = spawnSync('forge', args, { cwd: resolve('contracts'), env: { ...env, NETWORK: 'monad-testnet', FOUNDRY_BROADCAST: 'broadcast/sidequest-dev' }, stdio: ['ignore', log, log] })
  closeSync(log)
  console.log(JSON.stringify({ action, exitCode: result.status, privateLog: `.sidequest/contracts-${action}.log` }))
  if (result.status !== 0) process.exitCode = 1
} catch (error) {
  console.error(error instanceof Error && /^[a-z0-9-]+$/.test(error.message) ? error.message : 'contract-operation-failed-inspect-private-log')
  process.exitCode = 1
}
