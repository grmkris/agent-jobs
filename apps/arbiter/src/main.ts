/**
 * The portable arbiter (plan B2.4) as a long-running process: signs in to the board with the arbitrator key, keeps
 * the lease, and arbitrates every open dispute each pass. `--once` runs a single pass.
 *
 *   BOARD_URL=https://… bun apps/arbiter/src/main.ts [--once]   (from the repo root, with .env.local loaded)
 *
 * Env: ARBITRATOR_PRIVATE_KEY, ARBITER_MODEL_BASE_URL, ARBITER_MODEL, ARBITER_MODEL_API_KEY, NETWORK
 * (default monad-testnet), ARBITER_RUNNER (default arbiter@<host>), ARBITER_INTERVAL_SECONDS (default 60).
 */
import { hostname } from 'node:os'
import { proposeRuling } from '@agent-jobs/board'
import * as sdk from '@agent-jobs/sdk'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrateOnce } from './arbiter.ts'

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback
  if (v === undefined || v === '') throw new Error(`${name} is not set`)
  return v
}

const account = privateKeyToAccount(env('ARBITRATOR_PRIVATE_KEY') as Hex)
const network = env('NETWORK', 'monad-testnet') as sdk.Network
const endpoint = { baseUrl: env('ARBITER_MODEL_BASE_URL'), model: env('ARBITER_MODEL'), apiKey: env('ARBITER_MODEL_API_KEY') }
const runner = env('ARBITER_RUNNER', `arbiter@${hostname()}`)
const interval = Number(env('ARBITER_INTERVAL_SECONDS', '60'))
const board = sdk.boardClient(env('BOARD_URL'))
const log = (m: string) => console.log(`[arbiter ${new Date().toISOString().slice(11, 19)}] ${m}`)

await board.signIn(account)
log(`signed in as ${account.address} (runner ${runner}, model ${endpoint.model})`)
const deps = { board, account, network, runner, propose: (b: Parameters<typeof proposeRuling>[1]) => proposeRuling(endpoint, b), log }

if (process.argv.includes('--once')) {
  const { outcomes } = await arbitrateOnce(deps)
  process.exit(outcomes.some((o) => o.result === 'skipped') ? 2 : 0)
}
for (;;) {
  try {
    await arbitrateOnce(deps)
  } catch (e) {
    log(`pass failed: ${(e as Error).message}`)
    // Sessions last a day; sign in again rather than stop.
    if ((e as { code?: string }).code === 'unauthenticated') await board.signIn(account).catch(() => undefined)
  }
  await new Promise((r) => setTimeout(r, interval * 1000))
}
