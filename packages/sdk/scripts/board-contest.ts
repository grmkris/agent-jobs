/**
 * A contest through the hosted board (CP3), with both evidence labels: the publisher opens a contest that requires
 * the GitHub check "test"; the entrant (the testnet worker, ERC-8004 agent from .state.json) enters a finished commit
 * and signs its two authorisations once; the attester attests the candidate ("matches this submitted candidate");
 * the approver awards it in one transaction; the same statement then "matches the awarded on-chain deliverable".
 *
 *   BOARD_URL=https://… bun packages/sdk/scripts/board-contest.ts   (from the repo root; .env.local is loaded)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'
import { check, checks, env, log, sendReported } from './lib/common.ts'

const BOARD = env('BOARD_URL')
const RPC = env('MONAD_TESTNET_RPC_URL')
const ENTRY = {
  repo: 'https://github.com/grmkris/runner-spike-fixture',
  branch: 'dispatch/cb0b4323adb67f08',
  sha: 'c850f7a58015bafe065257f263a2ecc01da56dfe',
}
const agentId = (JSON.parse(readFileSync(join(import.meta.dirname, '.state.json'), 'utf8')) as { workerAgentId: string }).workerAgentId

const ctx = sdk.context('monad-testnet', 'demo', RPC)
const creatorAccount = privateKeyToAccount(env('TESTNET_CREATOR_PRIVATE_KEY') as Hex)
const workerAccount = privateKeyToAccount(env('TESTNET_WORKER_PRIVATE_KEY') as Hex)
const creator = sdk.wallet('monad-testnet', creatorAccount, RPC)
const worker = sdk.wallet('monad-testnet', workerAccount, RPC)
const pub = sdk.boardClient(BOARD)
const ent = sdk.boardClient(BOARD)


const send = (client: ReturnType<typeof sdk.boardClient>, w: sdk.Wallet, taskId: string, txs: sdk.TxRequest[], who: string) =>
  sendReported(client, w, ctx.publicClient, taskId, txs, who)

await pub.signIn(creatorAccount)
await ent.signIn(workerAccount)
const t0 = Math.floor(Date.now() / 1000)
const created = await pub.call('create_task', {
  title: 'Contest: CI workflow for runner-spike-fixture',
  brief: 'Submit a finished branch of grmkris/runner-spike-fixture whose GitHub check "test" passes. The approver may award early.',
  acceptanceCriteria: ['A GitHub check run named "test" completes with conclusion "success" on the submitted SHA.'],
  token: 'mUSD',
  reward: '7',
  creatorBond: '1',
  workerBond: '0',
  deliveryDeadline: t0 + 30 * 60,
  selectionDeadline: t0 + 15 * 60,
  mode: 'contest',
  stack: 'demo',
  requiredChecks: ['test'],
})
const taskId = created.taskId as string
log('publisher', `contest ${taskId}; Jev: ${created.screening.verdict} (${created.screening.reasons.join('; ')})`)
await send(pub, creator, taskId, created.transactions, 'publisher')
const open = await pub.call('get_task', { taskId })
check('prize escrowed and listing matches the offer', open.chain.status === 'open' && open.chain.listingMatchesOffer === true, `job ${open.jobId}`)

const prepared = await ent.call('prepare_entry', { taskId, agentId, ...ENTRY })
const [budgetSignature, submitSignature] = await Promise.all(
  (prepared.sign as Array<{ typedData: string }>).map((s) => sdk.signTypedDataJson(worker, s.typedData)),
)
await ent.call('submit_entry', { taskId, candidateId: prepared.candidateId, budgetSignature, submitSignature })
log('entrant', `entered candidate ${prepared.candidateId} (${ENTRY.sha.slice(0, 7)}) and goes offline`)

const ev = await pub.call('request_evidence', { taskId, candidateId: prepared.candidateId })
log('attester', `conclusion ${ev.conclusion}; attached → https://testnet.monadscan.com/tx/${ev.txHash}`)
check('candidate-level label before the award', ev.evidence.at(-1)?.label === 'matches this submitted candidate', ev.evidence.at(-1)?.label)

const candidates = await pub.call<Array<{ candidateId: string }>>('list_candidates', { taskId })
const awardTx = await pub.call('award', { taskId, candidateId: candidates[0]?.candidateId })
const before = await sdk.balanceOf(ctx, ctx.deployment.rewardTokens[0]!, workerAccount.address)
await send(pub, creator, taskId, awardTx.transactions, 'approver')
const after = await sdk.balanceOf(ctx, ctx.deployment.rewardTokens[0]!, workerAccount.address)
const done = await pub.call('get_task', { taskId })
check('awarded: Completed in one transaction', done.chain.status === 'completed', done.chain.status)
check('the offline entrant was paid 7 mUSD', after - before === 7_000_000n, `${after - before}`)
check('on-chain deliverable recorded from the award receipt', done.onchainSubmission?.deliverable_hash === prepared.deliverableHash)
check('the same evidence now matches the awarded on-chain deliverable', done.evidence.at(-1)?.label === 'matches the awarded on-chain deliverable', done.evidence.at(-1)?.label)
checks.done()
