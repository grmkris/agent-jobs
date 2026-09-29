/**
 * The worker half of an execution-budget test driven by a person in Explore (ADR-0009): agent 1942 waits for a hire
 * with a budget published by CREATOR, applies, activates once selected, waits for the grant, then draws once: half
 * of an advance's cap, or a call budget's function when it takes no arguments (e.g. `faucet()`). It reports every
 * transaction and leaves the job active, so the creator can watch the draw, revoke, approve or let it expire.
 *
 *   CREATOR=0x… bun packages/sdk/scripts/board-budget-worker.ts   (from the repo root; .env.local is read)
 *
 * BOARD_URL defaults to https://testnet.hireling.xyz; WAIT_MINUTES (default 120) bounds each wait.
 * Key: CAMPAIGN_CLAUDE_PRIVATE_KEY, agent CAMPAIGN_CLAUDE_AGENT_ID.
 */
import { type AbiFunction, type Address, type Hex, formatUnits, parseAbiItem, parseUnits, toFunctionSelector } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'
import { envLocal, log as stamp, sendReported, sleep } from './lib/common.ts'

const BOARD = envLocal('BOARD_URL', 'https://testnet.hireling.xyz')
const RPC = envLocal('MONAD_TESTNET_RPC_URL')
const CREATOR = envLocal('CREATOR').toLowerCase()
const WAIT_S = Number(envLocal('WAIT_MINUTES', '120')) * 60
const account = privateKeyToAccount(envLocal('CAMPAIGN_CLAUDE_PRIVATE_KEY') as Hex)
const worker = sdk.wallet('monad-testnet', account, RPC)
const agentId = envLocal('CAMPAIGN_CLAUDE_AGENT_ID')
const board = sdk.boardClient(BOARD)
const reads = sdk.context('monad-testnet', 'main', RPC).publicClient
const log = (m: string) => stamp('worker', m)

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + WAIT_S * 1000
  for (;;) {
    // A dropped connection on one poll is not the end of an hours-long wait; the next poll retries.
    const v = await probe().catch((e: Error) => {
      log(`poll failed, retrying: ${e.message}`)
      return undefined
    })
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

await board.signIn(account)
log(`agent ${agentId} (${account.address}) watching ${BOARD} for a budgeted hire from ${CREATOR}`)

const task = await until('a published hire with an execution budget', async () => {
  const index = await board.call<Array<{ taskId: string; jobId: string | null; creator: string; mode: string; title: string; executionBudget: unknown }>>('task_index', {})
  for (const t of index.filter((x) => x.creator.toLowerCase() === CREATOR && x.mode === 'hire' && x.executionBudget !== null && x.jobId !== null)) {
    const full = await board.call('get_task', { taskId: t.taskId })
    if (full.chain?.status === 'open') return t
  }
  return undefined
})
const taskId = task.taskId
log(`task ${taskId} (job ${task.jobId}): ${task.title}`)

const app = await board.call('apply', { taskId, agentId, note: 'Agent 1942 for the execution-budget test: I will draw once after your grant.' })
log(`applied (${app.applicationId}); waiting to be selected in Explore`)
await until('the selection', async () => ((await board.call('get_task', { taskId })).mine?.selected === true ? true : undefined))

const prep = await board.call('prepare_activation', { taskId })
const act = await board.call('build_activation', { taskId, budgetSignature: await sdk.signTypedDataJson(worker, prep.sign.typedData) })
await sendReported(board, worker, reads, taskId, act.transactions, 'worker')
log(`activated: job ${(await board.call('get_task', { taskId })).chain.status}; waiting for the grant in Explore`)

const budget = await until('the grant', async () => {
  const b = await board.call('get_budget', { taskId })
  if (b.status === 'live') return b
  if (b.status !== 'promised') throw new Error(`the budget is ${b.status} (${b.endedReason})`)
  return undefined
})
log(`granted: ${budget.kind} of ${budget.cap} ${budget.symbol}, expires ${new Date(budget.expiresAt * 1000).toISOString()}`)

let draw: { transactions: sdk.TxRequest[] }
if (budget.kind === 'advance') {
  const decimals = await reads.readContract({ address: budget.token as Address, abi: sdk.factoryTokenAbi, functionName: 'decimals' })
  const half = formatUnits(parseUnits(budget.cap, decimals) / 2n, decimals)
  log(`drawing ${half} ${budget.symbol}`)
  draw = await board.call('spend_budget', { taskId, amount: half, note: 'test draw: half the advance' })
} else {
  const fn = parseAbiItem(budget.function) as AbiFunction
  if (fn.inputs.length > 0) {
    log(`the call budget's ${fn.name} takes arguments; not calling it. Done.`)
    process.exit(0)
  }
  log(`calling ${fn.name}() from the creator's account`)
  draw = await board.call('spend_budget_call', { taskId, data: toFunctionSelector(fn), note: `test call: ${fn.name}()` })
}
await sendReported(board, worker, reads, taskId, draw.transactions, 'worker')
const after = await board.call('get_budget', { taskId })
log(`drawn ${after.drawn} of ${after.cap} ${after.symbol}; draws: ${after.draws.map((d: { amount: string | null; status: string }) => `${d.amount} ${d.status}`).join(', ')}`)
log('done: the job stays active. Revoke, approve or let it expire from Explore.')
