/**
 * Quote-to-hire through the hosted board (CP3, ADR-0004), with the Privy server wallet as the worker (its full
 * lifecycle: ERC-8004 registration, sign-in, quote, activation, submission, payment, all signed and sent by Privy).
 * The publisher requests quotes in mUSD or mEUR; the Privy agent and the cast worker quote privately; the publisher
 * picks the Privy quote; the ordinary offer is published with both hashes; select → activate → submit → evidence →
 * accept.
 *
 *   BOARD_URL=https://… bun packages/sdk/scripts/board-quote.ts   (from the repo root; .env.local is loaded)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'
import { check, checks, env, log, sendReported } from './lib/common.ts'

const BOARD = env('BOARD_URL')
const RPC = env('MONAD_TESTNET_RPC_URL')
const DELIVERABLE = { repo: 'https://github.com/grmkris/runner-spike-fixture', branch: 'dispatch/cb0b4323adb67f08', sha: 'c850f7a58015bafe065257f263a2ecc01da56dfe' }
const STATE = join(import.meta.dirname, '.state.json')
const state = JSON.parse(readFileSync(STATE, 'utf8')) as { workerAgentId: string; privyAgentId?: string }

const ctx = sdk.context('monad-testnet', 'demo', RPC)
const creatorAccount = privateKeyToAccount(env('TESTNET_CREATOR_PRIVATE_KEY') as Hex)
const castAccount = privateKeyToAccount(env('TESTNET_WORKER_PRIVATE_KEY') as Hex)
const creator = sdk.wallet('monad-testnet', creatorAccount, RPC)
const privy = sdk.privyWallet('monad-testnet', {
  appId: env('PRIVY_APP_ID'),
  appSecret: env('PRIVY_APP_SECRET'),
  walletId: env('PRIVY_SERVER_WALLET_ID'),
  address: env('PRIVY_SERVER_WALLET_ADDRESS') as Address,
}, RPC)
const pub = sdk.boardClient(BOARD)
const pw = sdk.boardClient(BOARD)
const cw = sdk.boardClient(BOARD)


const send = (client: ReturnType<typeof sdk.boardClient>, w: sdk.Wallet, taskId: string, txs: sdk.TxRequest[], who: string) =>
  sendReported(client, w, ctx.publicClient, taskId, txs, who, ctx.deployment.batchDelegate)

// The Privy wallet as an ERC-8004 agent holding FACTORY for its bond and the hold gate.
const factory = ctx.deployment.factory
if ((await sdk.balanceOf(ctx, factory, privy.account.address)) < 3n * 10n ** 18n) {
  const r = await sdk.faucet(ctx, privy, factory)
  log('privy', `faucet FACTORY → https://testnet.monadscan.com/tx/${r.transactionHash}`)
}
if (state.privyAgentId === undefined) {
  const id = await sdk.registerAgent(ctx, privy, 'https://github.com/grmkris/agent-jobs#testnet-privy-worker')
  state.privyAgentId = id.toString()
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`)
  log('privy', `registered as ERC-8004 agent ${id}`)
}
check('the Privy wallet is its agent’s wallet', (await sdk.agentWallet(ctx, BigInt(state.privyAgentId))).toLowerCase() === privy.account.address.toLowerCase())

await pub.signIn(creatorAccount)
await pw.signIn(sdk.signerOf(privy) as never)
await cw.signIn(castAccount)
const t0 = Math.floor(Date.now() / 1000)
const req = await pub.call('request_quotes', {
  title: 'Add CI to runner-spike-fixture (quoted)',
  brief: 'Add a GitHub Actions workflow that runs the existing tests on push and pull_request. Deliver a branch of grmkris/runner-spike-fixture.',
  acceptanceCriteria: ['A GitHub check run named "test" completes with conclusion "success" on the submitted SHA.'],
  tokens: ['mUSD', 'mEUR'],
  creatorBond: '1',
  workerBond: '1',
  deliveryDeadline: t0 + 40 * 60,
  quoteDeadline: t0 + 10 * 60,
  stack: 'demo',
  requiredChecks: ['test'],
})
log('publisher', `quote request ${req.requestId} (${req.status})`)
const open = await pw.call<Array<{ requestId: string }>>('list_quote_requests')
check('the request is public', open.some((r) => r.requestId === req.requestId))

const pq = await pw.call('submit_quote', { requestId: req.requestId, agentId: state.privyAgentId, token: 'mEUR', amount: '4.5', note: 'CI in one workflow file.' })
await cw.call('submit_quote', { requestId: req.requestId, agentId: state.workerAgentId, token: 'mUSD', amount: '4', note: 'cheaper' })
const mine = await pw.call('list_quotes', { requestId: req.requestId })
check('a bidder sees only its own quote', mine.quotes.length === 1 && mine.quotes[0].quoteId === pq.quoteId)
const all = await pub.call('list_quotes', { requestId: req.requestId })
check('the publisher sees both quotes', all.quotes.length === 2, all.quotes.map((q: any) => `${q.amount} ${q.symbol}`).join(', '))

// No automatic lowest bid: the publisher picks the Privy agent's mEUR quote.
const picked = await pub.call('pick_quote', { requestId: req.requestId, quoteId: pq.quoteId })
const taskId = picked.taskId as string
await send(pub, creator, taskId, picked.transactions, 'publisher')
const task = await pub.call('get_task', { taskId })
check('the offer carries the request and quote hashes', task.terms.quote?.requestHash === req.requestHash && task.terms.quote?.quoteHash === pq.quoteHash)
check('funded at the quoted amount, listing matches the offer', task.chain.listingMatchesOffer === true && task.reward === '4500000', `job ${task.jobId}, reward ${task.reward}`)
check('a second pick is refused', await pub.call('pick_quote', { requestId: req.requestId, quoteId: pq.quoteId }).then(() => false, () => true))

const sel = await pub.call('select_worker', { taskId, applicationId: picked.applicationId })
await pub.call('submit_selection', { taskId, nonce: sel.nonce, signature: await sdk.signTypedDataJson(creator, sel.sign.typedData) })
// Sign first: build_activation then returns the bond approval and activate, sent as one batch.
const prep = await pw.call('prepare_activation', { taskId })
const act = await pw.call('build_activation', { taskId, budgetSignature: await sdk.signTypedDataJson(privy, prep.sign.typedData) })
await send(pw, privy, taskId, act.transactions, 'privy')
const sub = await pw.call('submit_work', { taskId, ...DELIVERABLE })
await send(pw, privy, taskId, sub.transactions, 'privy')

const ev = await pub.call('request_evidence', { taskId })
log('attester', `conclusion ${ev.conclusion} → https://testnet.monadscan.com/tx/${ev.txHash}`)
const mEUR = ctx.deployment.rewardTokens[1]!
const [before, bondBefore] = await Promise.all([sdk.balanceOf(ctx, mEUR, privy.account.address), sdk.balanceOf(ctx, factory, privy.account.address)])
const acc = await pub.call('approve_work', { taskId })
await send(pub, creator, taskId, acc.transactions, 'approver')
const [after, bondAfter] = await Promise.all([sdk.balanceOf(ctx, mEUR, privy.account.address), sdk.balanceOf(ctx, factory, privy.account.address)])
const done = await pub.call('get_task', { taskId })
check('Completed', done.chain.status === 'completed', done.chain.status)
check('the Privy worker was paid 4.5 mEUR', after - before === 4_500_000n, `${after - before}`)
check('its bond returned', bondAfter - bondBefore === 10n ** 18n, `${bondAfter - bondBefore}`)
check('evidence matches the on-chain deliverable', done.evidence.at(-1)?.label === 'matches the awarded on-chain deliverable', done.evidence.at(-1)?.label)
checks.done()
