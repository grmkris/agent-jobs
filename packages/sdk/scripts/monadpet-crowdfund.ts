/**
 * Proof (b) of ADR-0007 on the `monad-pet` board: a feature crowdfunded through a JobPool.
 *
 *   MODE=cancel bun --env-file=.env.local packages/sdk/scripts/monadpet-crowdfund.ts
 *     create_pool (curator) → pledges 180 + 200 (B capped to 120) → launch by B → the curator cancels → settle →
 *     pool_refund A and B → reclaimHold.
 *   MODE=hire …
 *     the same up to launch, then a headless Claude worker applies through /b/monad-pet/mcp; the curator selects and
 *     signs (the board verifies the pool's ERC-1271 answer), the worker activates, pushes a feature branch and
 *     submits; the curator approves; the worker is paid 300 CHOMP and a refund finds nothing.
 *
 * Keys from .env.local: CURATOR_PRIVATE_KEY, PLEDGER_A_PRIVATE_KEY, PLEDGER_B_PRIVATE_KEY (5000 CHOMP each),
 * CAMPAIGN_CLAUDE_PRIVATE_KEY (the worker, through run-agent.sh). BOARD_URL defaults to staging.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import * as sdk from '@sidequest/sdk'
import { type Hex, formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { envLocal, log as stamp, sendReported, sleep } from './lib/common.ts'

const API = envLocal('BOARD_URL', 'https://dev.sidequest.exchange').replace(/\/$/, '')
const RPC = envLocal('MONAD_TESTNET_RPC_URL').split(' ')[0] as string
const BOARD = 'monad-pet'
const MODE = envLocal('MODE', 'cancel') as 'cancel' | 'hire'
const STACK = envLocal('STACK', 'demo') as sdk.StackName
const CHOMP = '0x130556848511554b181e645309754F265522F3c2' as const
const GOAL = '300'
const RUNS = envLocal('RUNS', '/tmp/monadpet-crowdfund')
const claudeAgent = envLocal('WORKER_AGENT_ID', '1942')
mkdirSync(RUNS, { recursive: true })

const ctx = sdk.context('monad-testnet', STACK, RPC)
const acct = (name: string) => privateKeyToAccount(envLocal(name) as Hex)
const curatorAccount = acct('CURATOR_PRIVATE_KEY')
const aAccount = acct('PLEDGER_A_PRIVATE_KEY')
const bAccount = acct('PLEDGER_B_PRIVATE_KEY')
const curator = sdk.wallet('monad-testnet', curatorAccount, RPC)
const pledgerA = sdk.wallet('monad-testnet', aAccount, RPC)
const pledgerB = sdk.wallet('monad-testnet', bAccount, RPC)
const boardFor = () => sdk.boardClient(`${API}/b/${BOARD}`)
const summary: string[] = []
const log = (m: string) => stamp(`proof-b/${MODE}`, m)
const note = (m: string) => {
  log(m)
  summary.push(m)
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

const chomp = (who: `0x${string}`) => sdk.balanceOf(ctx, CHOMP, who)
const fmt = (v: bigint) => formatUnits(v, 18)

function startClaudeWorker(taskId: string) {
  const root = join(import.meta.dirname, '../../..')
  const prompt = join(RUNS, 'feature-prompt.txt')
  const branch = `feature/blocks-since-breakfast-${taskId.slice(0, 6)}`
  const instruction = `Apply to the HIRE task ${taskId} on the sidequest board (the MCP server you have is that board: sign in with your wallet first, then \`apply\` with your agent id ${claudeAgent} and a one-line note). The listing's creator is a JobPool contract; its curator will select you and sign, so poll get_task until your selection appears, then activate with prepare_activation / build_activation and send the activation from your wallet. Do the work on a NEW branch named ${branch} of github.com/grmkris/monad-pet (clone with gh, never touch main): in web/public/app.js the pet already tracks blocks; add a small "blocks since breakfast" counter next to the meter that shows how many Monad blocks passed since the last feed (persist the feed block in localStorage with the existing state), with a line in web/public/index.html and matching styles. Commit, push the branch, then submit_work with deliverable {kind: "git", url: "https://github.com/grmkris/monad-pet", ref: "${branch}", sha: "<full 40-char commit sha>"}, send the submit transaction and report_transaction. Report the job id and stop.`
  const mk = spawn('bash', [join(root, 'packages/sdk/scripts/harness/worker-prompt.sh'), prompt, claudeAgent, 'monad-pet', instruction], { stdio: 'ignore' })
  return new Promise<void>((resolve, reject) => {
    mk.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`worker-prompt.sh exited ${code}`))
      const child = spawn('bash', [join(root, 'packages/sdk/scripts/harness/run-agent.sh'), 'claude', 'feature-claude', 'CAMPAIGN_CLAUDE_PRIVATE_KEY', prompt], {
        stdio: 'ignore',
        detached: true,
        env: { ...process.env, MCP_URL: `${API}/b/${BOARD}/mcp`, RUNS },
      })
      child.unref()
      log(`claude worker started (pid ${child.pid}); transcript ${RUNS}/feature-claude.jsonl`)
      resolve()
    })
  })
}

async function main() {
  const board = boardFor()
  await board.signIn(curatorAccount)
  log(`curator ${curatorAccount.address} signed in on /b/${BOARD}`)
  const now = Math.floor(Date.now() / 1000)
  const pledgeDeadline = now + 30 * 60
  const created = await board.call<{ poolId: string; taskId: string; termsHash: string; pool: `0x${string}`; transactions: sdk.TxRequest[] }>('create_pool', {
    title: 'Blocks-since-breakfast counter for the Monad Pet page',
    brief:
      'Add a small counter next to the pet’s hunger meter showing how many Monad blocks have passed since the pet was last fed. Keep the existing localStorage state shape, one new key at most. Plain JS, no build step.',
    acceptanceCriteria: ['A feature branch of grmkris/monad-pet', 'The counter renders and resets on feed', 'No change to the launched worker or main'],
    token: 'CHOMP',
    goal: GOAL,
    workerBond: '1',
    pledgeDeadline,
    deliveryDeadline: pledgeDeadline + 86_400 + 3 * 3600,
    mode: 'hire',
    stack: STACK,
    deliverable: { accepts: ['git'], target: 'a feature/… branch of github.com/grmkris/monad-pet' },
  })
  const poolId = created.poolId
  note(`pool ${poolId} (task ${created.taskId}), predicted address ${created.pool}, terms ${created.termsHash}`)
  await sendReported(board, curator, ctx.publicClient, poolId, created.transactions, 'curator')
  const code = await ctx.publicClient.getCode({ address: created.pool })
  if (code === undefined || code === '0x') throw new Error('the pool was not created at the predicted address')
  const p0 = await board.call<{ phase: string; totalPledged: string }>('get_pool', { poolId })
  note(`pool exists at ${created.pool}: phase ${p0.phase}, pledged ${fmt(BigInt(p0.totalPledged))} CHOMP, hold ${fmt(await sdk.balanceOf(ctx, ctx.deployment.factory, created.pool))} SIDE`)

  const a0 = await chomp(aAccount.address)
  const b0 = await chomp(bAccount.address)
  const boardA = boardFor()
  await boardA.signIn(aAccount)
  const pa = await boardA.call<{ transactions: sdk.TxRequest[] }>('pledge', { poolId, amount: '180' })
  await sendReported(boardA, pledgerA, ctx.publicClient, poolId, pa.transactions, 'pledger A')
  const boardB = boardFor()
  await boardB.signIn(bAccount)
  const pb = await boardB.call<{ transactions: sdk.TxRequest[] }>('pledge', { poolId, amount: '200' })
  await sendReported(boardB, pledgerB, ctx.publicClient, poolId, pb.transactions, 'pledger B')
  const p1 = await board.call<{ phase: string; totalPledged: string }>('get_pool', { poolId })
  const bPledged = await boardB.call<{ pledged: string }>('pledged_by', { poolId })
  note(`A pledged 180 (spent ${fmt(a0 - (await chomp(aAccount.address)))}), B asked 200 and was capped to ${fmt(BigInt(bPledged.pledged))} (spent ${fmt(b0 - (await chomp(bAccount.address)))}); pool ${fmt(BigInt(p1.totalPledged))}/${GOAL} CHOMP, phase ${p1.phase}`)

  const launch = await boardB.call<{ transactions: sdk.TxRequest[] }>('launch_pool', { poolId })
  const [launchHash] = await sendReported(boardB, pledgerB, ctx.publicClient, poolId, launch.transactions, 'pledger B')
  const task = await board.call<{ jobId: string | null; chain: { status: string; listingMatchesOffer: boolean } }>('get_task', { taskId: poolId })
  const listing = task.jobId === null ? null : await sdk.getListing(ctx, BigInt(task.jobId))
  note(`launched by B in ${launchHash}: job ${task.jobId}, chain ${task.chain.status}, listing matches offer ${task.chain.listingMatchesOffer}, listing creator ${listing?.creator} (the pool), approver ${listing?.approver} (the curator)`)
  if (task.jobId === null) throw new Error('the board did not record the job id from the launch receipt')

  if (MODE === 'cancel') {
    const c = await board.call<{ transactions: sdk.TxRequest[] }>('cancel_task', { taskId: poolId })
    await sendReported(board, curator, ctx.publicClient, poolId, c.transactions, 'curator')
    const after = await board.call<{ chain: { status: string } }>('get_task', { taskId: poolId })
    note(`curator cancelled through the pool; chain status ${after.chain.status}; pool holds ${fmt(await chomp(created.pool))} CHOMP again`)
    const ra = await boardA.call<{ transactions: sdk.TxRequest[]; reclaimHold: sdk.TxRequest }>('pool_refund', { poolId })
    await sendReported(boardA, pledgerA, ctx.publicClient, poolId, ra.transactions, 'pledger A')
    const rb = await boardB.call<{ transactions: sdk.TxRequest[] }>('pool_refund', { poolId })
    await sendReported(boardB, pledgerB, ctx.publicClient, poolId, rb.transactions, 'pledger B')
    const f0 = await sdk.balanceOf(ctx, ctx.deployment.factory, curatorAccount.address)
    await sendReported(board, curator, ctx.publicClient, poolId, [ra.reclaimHold], 'curator')
    note(`refunds: A ${fmt((await chomp(aAccount.address)) - a0)} (net of 180 pledged), B ${fmt((await chomp(bAccount.address)) - b0)} (net of 120); pool left with ${fmt(await chomp(created.pool))} CHOMP; hold reclaimed ${fmt((await sdk.balanceOf(ctx, ctx.deployment.factory, curatorAccount.address)) - f0)} SIDE`)
    const p2 = await board.call<{ phase: string; paidOut: string; refundable: boolean }>('get_pool', { poolId })
    note(`get_pool: phase ${p2.phase}, paid out ${fmt(BigInt(p2.paidOut))}, refundable ${p2.refundable}`)
    return
  }

  await startClaudeWorker(poolId)
  const app = await until('an application', 25 * 60, async () => {
    const apps = await board.call<Array<{ id: string; worker: string; agent_id: string; note: string }>>('list_applications', { taskId: poolId })
    return apps[0]
  })
  note(`application ${app.id} from ${app.worker} (agent ${app.agent_id}): ${app.note}`)
  const selection = await board.call<{ nonce: string; sign: { typedData: string } }>('select_worker', { taskId: poolId, applicationId: app.id })
  const signature = await sdk.signTypedDataJson(curator, selection.sign.typedData)
  const sub = await board.call<{ ok: boolean; worker: string }>('submit_selection', { taskId: poolId, nonce: selection.nonce, signature })
  note(`curator's Selection accepted by the board for a listing whose creator is the pool (ERC-1271): ${JSON.stringify(sub)}`)
  const w0 = await chomp(app.worker as `0x${string}`)
  const submitted = await until('a submission', 35 * 60, async () => {
    const t = await board.call<{ chain: { status: string }; deliverables: Array<{ repo?: string; branch?: string; sha?: string; deliverable_hash: string }> }>('get_task', { taskId: poolId })
    return ['submitted', 'completed', 'rejected', 'expired'].includes(t.chain.status) ? t : undefined
  })
  const d = submitted.deliverables.at(-1)
  note(`worker submitted ${d?.repo} ${d?.branch} @ ${d?.sha} (chain ${submitted.chain.status})`)
  if (submitted.chain.status !== 'submitted') throw new Error(`nothing to approve: ${submitted.chain.status}`)
  const ok = await board.call<{ transactions: sdk.TxRequest[] }>('approve_work', { taskId: poolId })
  await sendReported(board, curator, ctx.publicClient, poolId, ok.transactions, 'curator')
  const final = await board.call<{ chain: { status: string } }>('get_task', { taskId: poolId })
  note(`approved by the curator: chain ${final.chain.status}; worker CHOMP +${fmt((await chomp(app.worker as `0x${string}`)) - w0)}`)
  try {
    await sdk.poolRefund(ctx, pledgerA, created.pool)
    note('UNEXPECTED: a refund after a paid reward went through')
  } catch (e) {
    note(`refund after the paid reward refused as expected: ${(e as Error).message.split('\n')[0]}`)
  }
  const f0 = await sdk.balanceOf(ctx, ctx.deployment.factory, curatorAccount.address)
  await sdk.reclaimHold(ctx, curator, created.pool)
  note(`hold reclaimed: ${fmt((await sdk.balanceOf(ctx, ctx.deployment.factory, curatorAccount.address)) - f0)} SIDE back to the curator`)
}

main()
  .catch((e) => {
    note(`FAILED: ${(e as Error).message}`)
    process.exitCode = 1
  })
  .finally(() => {
    console.log(`\n=== proof (b) ${MODE} summary ===`)
    for (const l of summary) console.log(`- ${l}`)
  })
