/**
 * Shared by the overnight activity runtimes (hirers.ts, backers.ts): the dev testnet context, wallets from the env
 * file, one journaled state file per wallet, and one log line per event to stdout and events.jsonl. Testnet only:
 * FlowJournal refuses any chain but 10143, and this module refuses to start on anything else.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Hex, formatEther } from 'viem'
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'
import dev from '../../infra/dev.json' with { type: 'json' }
import * as sdk from '../../packages/sdk/src/index.ts'

export { sdk }
export const origin = dev.origin
export const stateRoot = process.env.ACTIVITY_STATE ?? resolve(import.meta.dirname, '../../.crew/activity/state')
mkdirSync(stateRoot, { recursive: true })
const rpc = process.env.MONAD_RPC_URL ?? ''
if (rpc === '') throw new Error('MONAD_RPC_URL is not set')
export const ctx = sdk.context('monad-testnet', 'main', rpc)
if (ctx.deployment.chainId !== 10143 || ctx.deployment.sidequest === null)
  throw new Error('activity runs on the Monad testnet v1 deployment only')
export const v1 = ctx.deployment.sidequest
export const explorer = 'https://testnet.monadscan.com/tx/'

/** A wallet from `<NAME>_PRIVATE_KEY` in the env file; the key never leaves this function. */
export function signerFor(name: string): { wallet: sdk.Wallet; account: PrivateKeyAccount } {
  const key = process.env[`${name.toUpperCase()}_PRIVATE_KEY`] ?? ''
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${name}: no key in the env file`)
  // SAFETY: the pattern above admits only 0x and 64 hex digits.
  const account = privateKeyToAccount(key as Hex)
  return { wallet: sdk.wallet('monad-testnet', account, rpc), account }
}

export function log(who: string, event: string, detail: Record<string, unknown> = {}) {
  const at = new Date().toISOString()
  console.log(`${at} ${who} ${event} ${JSON.stringify(detail)}`)
  appendFileSync(join(stateRoot, 'events.jsonl'), `${JSON.stringify({ at, who, event, ...detail })}\n`)
}

function write(path: string, text: string) {
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
}

export interface Saved<T> {
  flow: sdk.FlowState
  data: T
}

/** One wallet's state: its FlowJournal (`<name>.flow.json`) and the runtime's own data (`<name>.json`), each written atomically. */
export function store<T>(name: string, initial: T) {
  const flowPath = join(stateRoot, `${name}.flow.json`)
  const dataPath = join(stateRoot, `${name}.json`)
  const saved: Saved<T> = {
    flow: existsSync(flowPath)
      ? sdk.parseFlowJson(readFileSync(flowPath, 'utf8'))
      : { binding: '', values: {}, sends: {} },
    // SAFETY: only this runtime writes the data file, as the JSON of a T.
    data: existsSync(dataPath) ? (JSON.parse(readFileSync(dataPath, 'utf8')) as T) : initial,
  }
  const save = () => {
    write(flowPath, sdk.flowJson(saved.flow))
    write(dataPath, `${JSON.stringify(saved.data, null, 2)}\n`)
  }
  const journal = new sdk.FlowJournal(ctx, saved.flow, save, (label, hash) =>
    log(name, 'tx', { label, tx: `${explorer}${hash}` }),
  )
  return { saved, save, journal }
}

export const mon = async (address: Hex) => Number(formatEther(await ctx.publicClient.getBalance({ address })))
export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
export const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(Math.random() * items.length)]
export const between = (low: number, high: number) => low + Math.random() * (high - low)
export const now = () => Math.floor(Date.now() / 1000)
