/**
 * The publisher and approver side of a real hire through the hosted board (CP2): the testnet creator wallet signs in
 * to the board's REST API, publishes a task, selects the first applicant, and approves the submission only when the
 * named GitHub check passed on the exact submitted SHA; otherwise it rejects for quality. The worker side is a
 * separate agent (e.g. a Claude Code session with the board's MCP server and a cast wallet).
 *
 *   BOARD_URL=https://… bun packages/sdk/scripts/board-hire.ts   (from the repo root; .env.local is loaded)
 *
 * Task text via TASK_TITLE / TASK_BRIEF / TASK_CRITERIA (JSON array) / TASK_CHECK (the check name the approver
 * requires); STACK (default demo), TASK_TOKEN / TASK_REWARD, DELIVERY_MINUTES. REVIEW=manual stops after the
 * submission and its check for the approver to decide by hand (`board-review.ts`). TASK_CREATOR_BOND /
 * TASK_WORKER_BOND (FACTORY, default 2 / 1); APPLICANT selects only that worker address. MODE=contest publishes a
 * contest and stops (SELECTION_MINUTES); MODE=quote requests quotes (TASK_TOKENS, QUOTE_MINUTES), picks APPLICANT's
 * and continues as a hire.
 */
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'
import { env, log as stamp, sendReported, sleep } from './lib/common.ts'


const BOARD = env('BOARD_URL')
const RPC = env('MONAD_TESTNET_RPC_URL')
const CHECK = env('TASK_CHECK', 'test')
const STACK = env('STACK', 'demo') as sdk.StackName
const account = privateKeyToAccount(env('TESTNET_CREATOR_PRIVATE_KEY') as Hex)
const creator = sdk.wallet('monad-testnet', account, RPC)
const ctx = sdk.context('monad-testnet', STACK, RPC)
const board = sdk.boardClient(BOARD)
const log = (m: string) => stamp('publisher', m)

const send = (taskId: string, txs: sdk.TxRequest[]) => sendReported(board, creator, ctx.publicClient, taskId, txs, 'publisher', ctx.deployment.batchDelegate)

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
  const text = {
    title: env('TASK_TITLE', 'Add CI to runner-spike-fixture'),
    brief: env(
      'TASK_BRIEF',
      'Add a GitHub Actions workflow to https://github.com/grmkris/runner-spike-fixture that installs dependencies and runs the test suite on every push and pull request. Push it on a new branch of that repository (not main).',
    ),
    acceptanceCriteria:
      process.env.TASK_CRITERIA === undefined
        ? [
            `A GitHub check run named "${CHECK}" completes with conclusion "success" on the submitted SHA.`,
            'The workflow runs on push and pull_request and executes the repository’s existing tests.',
          ]
        : (JSON.parse(process.env.TASK_CRITERIA) as string[]),
  }
  const MODE = env('MODE', 'hire')
  const deliveryDeadline = now + Number(env('DELIVERY_MINUTES', '50')) * 60
  if (MODE === 'contest') {
    // A contest: publish the locked prize and stop; entries arrive over time and the approver awards by hand
    // (`board-review.ts DECISION=award`).
    const c = await board.call('create_task', {
      ...text,
      token: env('TASK_TOKEN', 'mEUR'),
      reward: env('TASK_REWARD', '10'),
      creatorBond: env('TASK_CREATOR_BOND', '2'),
      workerBond: '0',
      deliveryDeadline,
      selectionDeadline: now + Number(env('SELECTION_MINUTES', '40')) * 60,
      mode: 'contest',
      stack: STACK,
      requiredChecks: [CHECK],
    })
    await send(c.taskId as string, c.transactions)
    const t = await board.call('get_task', { taskId: c.taskId })
    log(`contest published: job ${t.jobId}, chain status ${t.chain.status}`)
    console.log(`TASK_ID=${c.taskId}`)
    return
  }
  let created: { taskId: string; termsHash: string; manifestUrl?: string; transactions: sdk.TxRequest[]; applicationId?: string }
  if (MODE === 'quote') {
    // Quote-to-hire: ask for quotes, pick the APPLICANT's (no automatic lowest bid), publish it as an ordinary hire.
    const req = await board.call('request_quotes', {
      ...text,
      tokens: env('TASK_TOKENS', 'mUSD,mEUR').split(','),
      creatorBond: env('TASK_CREATOR_BOND', '2'),
      workerBond: env('TASK_WORKER_BOND', '1'),
      deliveryDeadline,
      quoteDeadline: now + Number(env('QUOTE_MINUTES', '20')) * 60,
      stack: STACK,
      requiredChecks: [CHECK],
    })
    log(`quote request ${req.requestId}`)
    console.log(`REQUEST_ID=${req.requestId}`)
    const want = env('APPLICANT').toLowerCase()
    const quote = await until('a quote', Number(env('QUOTE_MINUTES', '20')) * 60, async () => {
      const qs = await board.call<{ quotes: Array<{ quoteId: string; worker: string; symbol: string; amount: string; note: string }> }>('list_quotes', { requestId: req.requestId })
      return qs.quotes.find((q) => q.worker.toLowerCase() === want)
    })
    log(`quote ${quote.quoteId}: ${quote.amount} ${quote.symbol} (${quote.note})`)
    created = await board.call('pick_quote', { requestId: req.requestId, quoteId: quote.quoteId })
  } else {
    created = await board.call('create_task', {
      ...text,
      token: env('TASK_TOKEN', 'mEUR'),
      reward: env('TASK_REWARD', '10'),
      creatorBond: env('TASK_CREATOR_BOND', '2'),
      workerBond: env('TASK_WORKER_BOND', '1'),
      deliveryDeadline,
      mode: 'hire',
      stack: STACK,
      requiredChecks: [CHECK],
    })
  }
  const taskId = created.taskId
  log(`task ${taskId}, terms ${created.termsHash}, manifest ${created.manifestUrl}`)
  await send(taskId, created.transactions)
  const published = await board.call('get_task', { taskId })
  log(`published: job ${published.jobId}, chain status ${published.chain.status}, listing matches offer: ${published.chain.listingMatchesOffer}`)
  console.log(`TASK_ID=${taskId}`)

  const app = await until('an application', 20 * 60, async () => {
    const apps = await board.call<Array<{ id: string; worker: string; agent_id: string; note: string }>>('list_applications', { taskId })
    // APPLICANT pins the hire to one worker address (a campaign names who takes which task); others are ignored.
    const want = process.env.APPLICANT?.toLowerCase()
    return want === undefined ? apps[0] : apps.find((a) => a.worker.toLowerCase() === want)
  })
  log(`application ${app.id} from ${app.worker} (agent ${app.agent_id}): ${app.note}`)
  const selection = await board.call('select_worker', { taskId, applicationId: app.id })
  const signature = await sdk.signTypedDataJson(creator, selection.sign.typedData)
  await board.call('submit_selection', { taskId, nonce: selection.nonce, signature })
  log('selection signed and submitted; waiting for the worker to activate and submit')

  const submitted = await until('a submission', Number(env('DELIVERY_MINUTES', '50')) * 60, async () => {
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

  const verdict = await until('a completed check', 30 * 60, async () => {
    const c = await checkPassed(deliverable.repo, deliverable.sha)
    return c.detail.includes('in_progress') || c.detail.includes('queued') || c.detail === 'no check runs' ? undefined : c
  })
  log(`GitHub checks on ${deliverable.sha}: ${verdict.detail}`)
  if (process.env.REVIEW === 'manual') {
    log(`manual review: check ${verdict.ok ? 'passed' : 'did not pass'}; on-chain deliverable ${onChain === undefined ? 'not found' : 'found'}. Decide with approve_work / reject_work.`)
    return
  }
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
