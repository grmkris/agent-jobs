/**
 * The approver's decision on a submitted task, after a human or agent review (the second half of `board-hire.ts`
 * with REVIEW=manual): the testnet creator wallet signs in to the board and approves, or rejects naming a violation
 * and a published reason, then sends the returned transactions and reports each one.
 *
 *   BOARD_URL=https://… TASK_ID=… DECISION=approve bun packages/sdk/scripts/board-review.ts
 *   BOARD_URL=https://… TASK_ID=… DECISION=reject VIOLATION=Quality REASON='…' bun packages/sdk/scripts/board-review.ts
 *
 * Also `DECISION=status` (prints the board's and the chain's view), `DECISION=candidates` / `DECISION=award
 * CANDIDATE=…` for a contest, and `DECISION=settle` (sends whatever `settlement_actions` returns: timeouts and
 * Holding's settle, permissionless).
 */
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined || v === '') throw new Error(`${name} is not set`)
  return v
}

const RPC = env('MONAD_TESTNET_RPC_URL')
const account = privateKeyToAccount(env('TESTNET_CREATOR_PRIVATE_KEY') as Hex)
const creator = sdk.wallet('monad-testnet', account, RPC)
const board = sdk.boardClient(env('BOARD_URL'))
const taskId = env('TASK_ID')
const log = (msg: string) => console.log(`[approver ${new Date().toISOString().slice(11, 19)}] ${msg}`)

async function send(txs: sdk.TxRequest[]) {
  const ctx = sdk.context('monad-testnet', 'main', RPC)
  const hashes = await sdk.sendAll(creator, ctx.publicClient, txs)
  for (const [i, h] of hashes.entries()) {
    log(`${txs[i]?.description} → https://testnet.monadscan.com/tx/${h}`)
    await board.call('report_transaction', { taskId, txHash: h })
  }
}

await board.signIn(account)
const decision = env('DECISION')
if (decision === 'approve') {
  await send((await board.call('approve_work', { taskId })).transactions)
} else if (decision === 'reject') {
  const r = await board.call('reject_work', { taskId, violation: env('VIOLATION', 'Quality'), reason: env('REASON') })
  await send(r.transactions)
} else if (decision === 'award') {
  await send((await board.call('award', { taskId, candidateId: env('CANDIDATE') })).transactions)
} else if (decision === 'candidates') {
  for (const c of await board.call<Array<Record<string, unknown>>>('list_candidates', { taskId })) log(JSON.stringify(c))
} else if (decision === 'settle') {
  const r = await board.call('settlement_actions', { taskId })
  await send(r.transactions ?? [])
} else if (decision !== 'status') {
  throw new Error(`unknown DECISION ${decision}`)
}
const t = await board.call('get_task', { taskId })
log(`job ${t.jobId}: chain status ${t.chain?.status}; deliverables ${JSON.stringify(t.deliverables?.map((d: { repo: string; sha: string }) => `${d.repo}@${d.sha.slice(0, 8)}`) ?? [])}`)
