import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkPasswordFile } from './password.ts'
import { parsePriceList, recoverPriceListSigner, typedDataJson, type PriceListFile } from './prices.ts'
import type { Address, Hex } from './viem.ts'

// bun scripts/mining/sign-prices.ts <unsigned message JSON> --network monad-testnet|monad-mainnet --out <signed JSON>
//   (--account <keystore name> | --keystore <path>) --password-file <0600 file> [--config <config JSON>]
//   Testnet fallback only: --private-key-env <ENV VAR NAME>. Signs with `cast wallet sign --data --from-file`.

const argv = process.argv.slice(2)
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const [input] = argv
const network = flag('network')
const out = flag('out')
if (input === undefined || out === undefined || (network !== 'monad-testnet' && network !== 'monad-mainnet')) {
  throw new Error('usage: bun scripts/mining/sign-prices.ts <unsigned.json> --network monad-testnet|monad-mainnet --out <signed.json> (--account <name> | --keystore <path>) --password-file <file>')
}
const configPath = resolve(flag('config') ?? join(import.meta.dirname, '../../contracts/config', `${network}.json`))
const config = JSON.parse(readFileSync(configPath, 'utf8')) as { chainId: number; deployment: { sidequest?: { distributor: Address } } }
const distributor = config.deployment.sidequest?.distributor
if (distributor === undefined) throw new Error(`${configPath} records no v1 deployment`)

let signerArgs: string[]
const keyEnv = flag('private-key-env')
if (keyEnv !== undefined) {
  if (network === 'monad-mainnet' || config.chainId === 143) throw new Error('mainnet signs from a keystore, never a raw key')
  const key = process.env[keyEnv]
  if (key === undefined || key === '') throw new Error(`set ${keyEnv}`)
  signerArgs = ['--private-key', key]
} else {
  const account = flag('account')
  const keystore = flag('keystore')
  const password = flag('password-file')
  if ((account === undefined) === (keystore === undefined) || password === undefined) {
    throw new Error('pass --account <name> or --keystore <path>, and --password-file <file>')
  }
  checkPasswordFile(password)
  signerArgs = [...(account !== undefined ? ['--account', account] : ['--keystore', keystore!]), '--password-file', password]
}

/** Runs cast; a failure reports cast's own stderr, never the command line (it may hold a key). */
function cast(args: string[]): string {
  const run = spawnSync('cast', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } })
  if (run.status !== 0) throw new Error(`cast ${args[0]} ${args[1]} failed: ${(run.stderr ?? '').trim().split('\n').slice(-3).join(' ')}`)
  return run.stdout.trim()
}

const unsigned = JSON.parse(readFileSync(input, 'utf8')) as PriceListFile['message'] | PriceListFile
const message = 'message' in unsigned ? unsigned.message : unsigned
const list = parsePriceList({ message })
const typed = typedDataJson(config.chainId, distributor, list)

const dir = mkdtempSync(join(tmpdir(), 'prices-'))
try {
  const typedPath = join(dir, 'typed.json')
  writeFileSync(typedPath, JSON.stringify(typed), { mode: 0o600 })
  const signature = cast(['wallet', 'sign', '--data', '--from-file', typedPath, ...signerArgs]) as Hex
  const signer = cast(['wallet', 'address', ...signerArgs]).toLowerCase() as Address
  const recovered = await recoverPriceListSigner(list, signature, config.chainId, distributor)
  if (recovered !== signer) throw new Error(`the signature recovers ${recovered}, not the signer ${signer}`)
  writeFileSync(out, `${JSON.stringify({ domain: typed.domain, message: typed.message, signer, signature }, null, 2)}\n`)
  console.log(`signed epoch ${list.epoch} prices for chain ${config.chainId} as ${signer}: ${out}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
