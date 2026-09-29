/**
 * The approver's decision on a submitted task, after a human or agent review (the second half of `board-hire.ts`
 * with REVIEW=manual): the testnet creator wallet signs in to the board and approves, or rejects naming a violation
 * and a published reason, then sends the returned transactions and reports each one.
 *
 *   BOARD_URL=https://… TASK_ID=… DECISION=approve bun packages/sdk/scripts/board-review.ts
 *   BOARD_URL=https://… TASK_ID=… DECISION=reject VIOLATION=Quality REASON='…' bun packages/sdk/scripts/board-review.ts
 *
 * Also `DECISION=status` (prints the board's and the chain's view), `DECISION=candidates` / `DECISION=evidence` /
 * `DECISION=award CANDIDATE=…` for a contest, and `DECISION=settle` (sends whatever `settlement_actions` returns: timeouts and
 * Holding's settle, permissionless).
 */
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'
import { env, log as stamp, sendReported } from './lib/common.ts'


const RPC = env('MONAD_TESTNET_RPC_URL')
const account = privateKeyToAccount(env('TESTNET_CREATOR_PRIVATE_KEY') as Hex)
const creator = sdk.wallet('monad-testnet', account, RPC)
const board = sdk.boardClient(env('BOARD_URL'))
const taskId = env('TASK_ID')
const log = (m: string) => stamp('approver', m)

const send = (txs: sdk.TxRequest[]) =>
  sendReported(board, creator, sdk.context('monad-testnet', 'main', RPC).publicClient, taskId, txs, 'approver', sdk.context('monad-testnet', 'main', RPC).deployment.delegation.delegator)

await board.signIn(account)
const decision = env('DECISION')
if (decision === 'approve') {
  await send((await board.call('approve_work', { taskId })).transactions)
} else if (decision === 'reject') {
  const r = await board.call('reject_work', { taskId, violation: env('VIOLATION', 'Quality'), reason: env('REASON') })
  await send(r.transactions)
} else if (decision === 'award') {
  await send((await board.call('award', { taskId, candidateId: env('CANDIDATE') })).transactions)
} else if (decision === 'evidence') {
  const e = await board.call('request_evidence', { taskId, ...(process.env.CANDIDATE === undefined ? {} : { candidateId: process.env.CANDIDATE }) })
  log(`evidence: conclusion ${e.conclusion}${e.txHash == null ? '' : ` → https://testnet.monadscan.com/tx/${e.txHash}`}`)
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
