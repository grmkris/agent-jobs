/**
 * The portable arbiter (plan B2.4) as a long-running process: signs in to the board with the arbitrator key, keeps
 * the lease, and arbitrates every open dispute each pass. `--once` runs a single pass.
 *
 *   BOARD_URL=https://… bun apps/arbiter/src/main.ts [--once]   (from the repo root, with .env.local loaded)
 *
 * Env: ARBITRATOR_PRIVATE_KEY (legacy), V1_ARBITRATOR_PRIVATE_KEY (v1), ARBITER_MODEL_BASE_URL,
 * ARBITER_MODEL, ARBITER_MODEL_API_KEY, NETWORK (default monad-testnet), ARBITER_RUNNER
 * (default arbiter@<host>), ARBITER_INTERVAL_SECONDS (default 60). Each key signs in separately;
 * the board returns only disputes whose named arbitrator matches that session.
 */
import { hostname } from 'node:os'
import { ARBITER_PROMPT_VERSION, proposeRuling } from '@agent-jobs/board'
import * as sdk from '@agent-jobs/sdk'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrateOnce } from './arbiter.ts'

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback
  if (v === undefined || v === '') throw new Error(`${name} is not set`)
  return v
}

const accounts = [
  privateKeyToAccount(env('ARBITRATOR_PRIVATE_KEY') as Hex),
  privateKeyToAccount(env('V1_ARBITRATOR_PRIVATE_KEY') as Hex),
]
const network = env('NETWORK', 'monad-testnet') as sdk.Network
const endpoint = { baseUrl: env('ARBITER_MODEL_BASE_URL'), model: env('ARBITER_MODEL'), apiKey: env('ARBITER_MODEL_API_KEY') }
const runner = env('ARBITER_RUNNER', `arbiter@${hostname()}`)
const interval = Number(env('ARBITER_INTERVAL_SECONDS', '60'))
const log = (m: string) => console.log(`[arbiter ${new Date().toISOString().slice(11, 19)}] ${m}`)
const clients = accounts.map(account => ({ account, board: sdk.boardClient(env('BOARD_URL')) }))

async function pass({ account, board }: (typeof clients)[number]) {
  await board.signIn(account)
  log(`signed in as ${account.address} (runner ${runner}, model ${endpoint.model})`)
  return arbitrateOnce({
    board,
    account,
    network,
    runner,
    propose: (b: Parameters<typeof proposeRuling>[1]) => proposeRuling(endpoint, b),
    log,
    model: endpoint.model,
    promptVersion: ARBITER_PROMPT_VERSION,
    sendCancellation: async (transaction: sdk.TxRequest) => {
      const rpcUrl = env(network === 'monad-mainnet' ? 'HIRELING_PROD_MONAD_RPC_URL' : 'MONAD_TESTNET_RPC_URL')
      await sdk.sendAll(sdk.wallet(network, account, rpcUrl), sdk.context(network, 'main', rpcUrl).publicClient, [transaction])
    },
  })
}

if (process.argv.includes('--once')) {
  const results = []
  for (const client of clients) results.push(await pass(client))
  process.exit(results.some(({ outcomes }) => outcomes.some((o) => o.result === 'skipped')) ? 2 : 0)
}
for (;;) {
  for (const client of clients) {
    try {
      await pass(client)
    } catch (e) {
      log(`pass for ${client.account.address} failed: ${(e as Error).message}`)
    }
  }
  await new Promise((r) => setTimeout(r, interval * 1000))
}
