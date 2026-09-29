/**
 * Creates or updates a tenant board (ADR-0008) on the hosted API from a key in .env.local.
 *
 *   BOARD_URL=… KEY_VAR=TESTNET_CREATOR_PRIVATE_KEY bun packages/sdk/scripts/board-admin.ts create-board \
 *     --slug monad-pet --name "Monad Pet" --stacks main,demo --tokens mUSD,mEUR --origins https://a.example,http://localhost:* --drip
 *   … board-admin.ts update-board --slug monad-pet --tokens mUSD,mEUR,CHOMP --stacks main,demo,fast
 *   … board-admin.ts update-board --slug monad-pet --verifiers '{"monad-pet":["0x…"]}'
 *   … board-admin.ts get-board --slug monad-pet
 */
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'
import { env, envLocal, log } from './lib/common.ts'

const [command, ...rest] = process.argv.slice(2)
const flags: Record<string, string | true> = {}
for (let i = 0; i < rest.length; i++) {
  const a = rest[i] as string
  if (!a.startsWith('--')) continue
  const next = rest[i + 1]
  if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true
  else {
    flags[a.slice(2)] = next
    i++
  }
}
const list = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string).split(',').map((s) => s.trim()).filter(Boolean) : undefined)
const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)

const board = sdk.boardClient(env('BOARD_URL'))
const key = envLocal(env('KEY_VAR', 'TESTNET_CREATOR_PRIVATE_KEY'))
const me = privateKeyToAccount(key as Hex)
await board.signIn(me)
log('admin', `signed in as ${me.address}`)

const slug = str('slug')
if (command === 'get-board') {
  console.log(JSON.stringify(await board.call('get_board', slug === undefined ? {} : { boardId: slug }), null, 2))
} else if (command === 'list-boards') {
  console.log(JSON.stringify(await board.call('list_boards'), null, 2))
} else if (command === 'create-board' || command === 'update-board') {
  if (slug === undefined) throw new Error('--slug is required')
  const args: Record<string, unknown> = {
    ...(command === 'create-board' ? { slug } : { boardId: slug }),
    ...(str('name') === undefined ? {} : { name: str('name') }),
    ...(list('stacks') === undefined ? {} : { stacks: list('stacks') }),
    ...(str('default-stack') === undefined ? {} : { defaultStack: str('default-stack') }),
    ...(list('tokens') === undefined ? {} : { rewardTokens: list('tokens') }),
    ...(list('origins') === undefined ? {} : { allowedOrigins: list('origins') }),
    ...(flags.drip === undefined ? {} : { drip: flags.drip === true || flags.drip === 'true' }),
    ...(str('approver') === undefined ? {} : { defaultApprover: str('approver') }),
    ...(str('deliverable') === undefined ? {} : { deliverableDefault: JSON.parse(str('deliverable') as string) }),
    ...(str('verifiers') === undefined ? {} : { verifiers: JSON.parse(str('verifiers') as string) }),
    ...(str('webhook') === undefined ? {} : { webhookUrl: str('webhook') }),
    ...(flags['rotate-webhook-secret'] === undefined ? {} : { rotateWebhookSecret: true }),
  }
  const r = await board.call<{ board: { id: string }; webhookSecret?: string }>(command === 'create-board' ? 'create_board' : 'update_board', args)
  if (r.webhookSecret !== undefined) log('admin', 'webhook secret (shown once; put it in the host as AGENT_JOBS_WEBHOOK_SECRET): ' + r.webhookSecret)
  delete r.webhookSecret
  console.log(JSON.stringify(r, null, 2))
} else {
  throw new Error('usage: board-admin.ts get-board|list-boards|create-board|update-board --slug <slug> [...]')
}
