/**
 * The publisher and approver side of a real hire through the hosted board (CP2): the testnet creator wallet signs in
 * to the board's REST API, publishes a task, selects the first applicant, and approves the submission only when the
 * named GitHub check passed on the exact submitted SHA; otherwise it rejects for quality. The worker side is a
 * separate agent (e.g. a Claude Code session with the board's MCP server and a cast wallet).
 *
 *   BOARD_URL=https://… bun packages/sdk/scripts/board-hire.ts   (from the repo root; .env.local is loaded)
 *
 * Task text via TASK_TITLE / TASK_BRIEF / TASK_CHECK (the check name the approver requires); demo windows.
 */
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined || v === '') throw new Error(`${name} is not set`)
  return v
}

const BOARD = env('BOARD_URL')
const RPC = env('MONAD_TESTNET_RPC_URL')
const CHECK = env('TASK_CHECK', 'test')
const account = privateKeyToAccount(env('TESTNET_CREATOR_PRIVATE_KEY') as Hex)
const creator = sdk.wallet('monad-testnet', account, RPC)
const ctx = sdk.context('monad-testnet', 'demo', RPC)
const board = sdk.boardClient(BOARD)
const log = (msg: string) => console.log(`[publisher ${new Date().toISOString().slice(11, 19)}] ${msg}`)
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000))

async function send(taskId: string, txs: sdk.TxRequest[]) {
  const hashes = await sdk.sendAll(creator, ctx.publicClient, txs)
  for (const [i, h] of hashes.entries()) {
    log(`${txs[i]?.description} → https://testnet.monadscan.com/tx/${h}`)
    await board.call('report_transaction', { taskId, txHash: h })
  }
}

async function until<T>(what: string, timeoutS: number, probe: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + timeoutS * 1000
  for (;;) {
    const v = await probe()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(15)
  }
}

async function checkPassed(repo: string, sha: string): Promise<{ ok: boolean; detail: string }> {
  const slug = repo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
  const res = await fetch(`https://api.github.com/repos/${slug}/commits/${sha}/check-runs`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-jobs-approver' },
  })
  const body = (await res.json()) as { check_runs?: Array<{ name: string; status: string; conclusion: string | null }> }
  const runs = body.check_runs ?? []
  const named = runs.find((r) => r.name === CHECK)
  const detail = runs.map((r) => `${r.name}:${r.status}/${r.conclusion}`).join(', ') || 'no check runs'
  return { ok: named?.status === 'completed' && named.conclusion === 'success', detail }
}

async function main() {
  await board.signIn(account)
  log(`signed in as ${account.address}`)
  const now = Math.floor(Date.now() / 1000)
  const created = await board.call('create_task', {
    title: env('TASK_TITLE', 'Add CI to runner-spike-fixture'),
    brief: env(
      'TASK_BRIEF',
      'Add a GitHub Actions workflow to https://github.com/grmkris/runner-spike-fixture that installs dependencies and runs the test suite on every push and pull request. Push it on a new branch of that repository (not main).',
    ),
    acceptanceCriteria: [
      `A GitHub check run named "${CHECK}" completes with conclusion "success" on the submitted SHA.`,
      'The workflow runs on push and pull_request and executes the repository’s existing tests.',
    ],
    token: 'mEUR',
    reward: '10',
    creatorBond: '2',
    workerBond: '1',
    deliveryDeadline: now + 50 * 60,
    mode: 'hire',
    stack: 'demo',
  })
  const taskId = created.taskId as string
  log(`task ${taskId}, terms ${created.termsHash}, manifest ${created.manifestUrl}`)
  await send(taskId, created.transactions)
  const published = await board.call('get_task', { taskId })
  log(`published: job ${published.jobId}, chain status ${published.chain.status}, listing matches offer: ${published.chain.listingMatchesOffer}`)
  console.log(`TASK_ID=${taskId}`)

  const app = await until('an application', 30 * 60, async () => {
    const apps = await board.call<Array<{ id: string; worker: string; agent_id: string; note: string }>>('list_applications', { taskId })
    return apps[0]
  })
  log(`application ${app.id} from ${app.worker} (agent ${app.agent_id}): ${app.note}`)
  const selection = await board.call('select_worker', { taskId, applicationId: app.id })
  const signature = await sdk.signTypedDataJson(creator, selection.sign.typedData)
  await board.call('submit_selection', { taskId, nonce: selection.nonce, signature })
  log('selection signed and submitted; waiting for the worker to activate and submit')

  const submitted = await until('a submission', 45 * 60, async () => {
    const t = await board.call('get_task', { taskId })
    if (t.chain.status === 'active') return undefined
    return ['submitted', 'completed', 'rejected', 'expired'].includes(t.chain.status) ? t : undefined
  })
  const deliverable = submitted.deliverables.at(-1)
  log(`worker submitted ${deliverable?.repo} ${deliverable?.branch} @ ${deliverable?.sha} (status ${submitted.chain.status})`)
  if (submitted.chain.status !== 'submitted' || deliverable === undefined) throw new Error('nothing to review')

  // The on-chain submission must be exactly the deliverable the board recorded.
  const job = await sdk.getJob(ctx, BigInt(submitted.jobId))
  // The public RPC answers eth_getLogs for at most 100 blocks, so walk back in windows.
  const head = await ctx.publicClient.getBlockNumber()
  let onChain: Hex | undefined
  for (let to = head; to > head - 5000n && onChain === undefined; to -= 100n) {
    const logs = await ctx.publicClient.getContractEvents({
      address: ctx.deployment.core,
      abi: sdk.coreAbi,
      eventName: 'JobSubmitted',
      args: { jobId: BigInt(submitted.jobId) },
      fromBlock: to - 99n,
      toBlock: to,
    })
    onChain = (logs.at(-1)?.args as { deliverable?: Hex } | undefined)?.deliverable
  }
  log(`on-chain deliverable ${onChain} (board record ${deliverable.deliverable_hash}); provider ${job.provider}`)

  const verdict = await until('a completed check', 15 * 60, async () => {
    const c = await checkPassed(deliverable.repo, deliverable.sha)
    return c.detail.includes('in_progress') || c.detail.includes('queued') || c.detail === 'no check runs' ? undefined : c
  })
  log(`GitHub checks on ${deliverable.sha}: ${verdict.detail}`)
  if (verdict.ok && onChain?.toLowerCase() === deliverable.deliverable_hash.toLowerCase()) {
    const a = await board.call('approve_work', { taskId })
    await send(taskId, a.transactions)
  } else {
    const r = await board.call('reject_work', {
      taskId,
      violation: 'Quality',
      reason: `Check "${CHECK}" did not pass on ${deliverable.sha}: ${verdict.detail}`,
    })
    await send(taskId, r.transactions)
  }
  const final = await board.call('get_task', { taskId })
  log(`final chain status: ${final.chain.status}`)
}

await main()
