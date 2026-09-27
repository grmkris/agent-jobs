/**
 * Live protocol flows on Monad testnet through the SDK only, against the deployed demo stack (2m review, 2m
 * dispute, 5m arbitration). Every step is a real transaction; every money outcome is checked against balances.
 *
 *   bun packages/sdk/scripts/flows.ts [hire|silence|dispute|contest|noshow|cancel|unpicked|lapse|lapse-none|timeout|falsified|all]
 *   (from the repo root; a comma-separated list runs several)
 *
 * Bun loads `.env.local` from the working directory: MONAD_TESTNET_RPC_URL, TESTNET_CREATOR_PRIVATE_KEY (creator
 * and approver), TESTNET_WORKER_PRIVATE_KEY (the `cast`-style worker), RELAY_PRIVATE_KEY (sends timeouts and the
 * signed ruling), ARBITRATOR_PRIVATE_KEY (signs the ruling only, sends nothing). Testnet only: the script refuses
 * any other chain.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'

const NETWORK = 'monad-testnet'
const EXPLORER = 'https://testnet.monadscan.com/tx/'
const STATE = join(import.meta.dirname, '.state.json')

function env(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') throw new Error(`${name} is not set (.env.local)`)
  return v
}

const rpc = env('MONAD_TESTNET_RPC_URL')
const ctx = sdk.context(NETWORK, 'demo', rpc)
const creator = sdk.wallet(NETWORK, privateKeyToAccount(env('TESTNET_CREATOR_PRIVATE_KEY') as Hex), rpc)
const worker = sdk.wallet(NETWORK, privateKeyToAccount(env('TESTNET_WORKER_PRIVATE_KEY') as Hex), rpc)
const relay = sdk.wallet(NETWORK, privateKeyToAccount(env('RELAY_PRIVATE_KEY') as Hex), rpc)
const arbitrator = sdk.wallet(NETWORK, privateKeyToAccount(env('ARBITRATOR_PRIVATE_KEY') as Hex), rpc)

const [mUSD, mEUR] = ctx.deployment.rewardTokens as [Address, Address]
const FACTORY = ctx.deployment.factory
const REWARD = 25_000_000n
const CREATOR_BOND = 5n * 10n ** 18n
const WORKER_BOND = 3n * 10n ** 18n

let failures = 0
const log = (flow: string, msg: string) => console.log(`[${flow}] ${msg}`)
const tx = (flow: string, what: string, r: { transactionHash: Hex }) => log(flow, `${what}: ${EXPLORER}${r.transactionHash}`)
function check(flow: string, what: string, actual: bigint, expected: bigint) {
  const ok = actual === expected
  if (!ok) failures++
  log(flow, `${ok ? '✓' : '✗'} ${what}: ${actual}${ok ? '' : ` (expected ${expected})`}`)
}

async function now(): Promise<number> {
  return Number((await ctx.publicClient.getBlock()).timestamp)
}

async function waitUntilAfter(flow: string, t: number) {
  let n = await now()
  if (n > t) return
  log(flow, `waiting ${t - n + 1}s of chain time`)
  while (n <= t) {
    await new Promise((r) => setTimeout(r, Math.min(10, t - n + 1) * 1000))
    n = await now()
  }
}

// -------------------------------------------------------------------------------------------------
// Setup: tokens, allowances and the worker's ERC-8004 agent
// -------------------------------------------------------------------------------------------------

interface State {
  workerAgentId?: string
}

async function setup(): Promise<bigint> {
  if ((await ctx.publicClient.getChainId()) !== ctx.deployment.chainId) throw new Error('wrong chain')
  const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}
  const need: Array<[sdk.Wallet, Address, bigint]> = [
    [creator, FACTORY, 40n * 10n ** 18n],
    [worker, FACTORY, 20n * 10n ** 18n],
    [creator, mUSD, 200_000_000n],
    [creator, mEUR, 200_000_000n],
  ]
  for (const [w, token, min] of need) {
    if ((await sdk.balanceOf(ctx, token, w.account.address)) < min) {
      tx('setup', `faucet ${token} → ${w.account.address}`, await sdk.faucet(ctx, w, token))
    }
  }
  let agentId = state.workerAgentId === undefined ? undefined : BigInt(state.workerAgentId)
  if (agentId === undefined || (await sdk.agentWallet(ctx, agentId)) !== worker.account.address) {
    agentId = await sdk.registerAgent(ctx, worker, 'https://github.com/grmkris/agent-jobs#testnet-cast-worker')
    state.workerAgentId = agentId.toString()
    writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`)
    log('setup', `worker registered as ERC-8004 agent ${agentId}`)
  }
  log('setup', `worker agent ${agentId}, wallet ${worker.account.address}`)
  return agentId
}

// -------------------------------------------------------------------------------------------------
// Building blocks
// -------------------------------------------------------------------------------------------------

async function publishHire(flow: string, token: Address, deliveryIn: number) {
  const deliveryDeadline = (await now()) + deliveryIn
  const termsHash = sdk.hashText(`${flow}-${Date.now()}-${sdk.randomNonce()}`)
  const { jobId, receipt } = await sdk.publish(ctx, creator, {
    mode: 'hire',
    token,
    reward: REWARD,
    creatorBond: CREATOR_BOND,
    workerBond: WORKER_BOND,
    manifestHash: sdk.hashText(`manifest ${flow}`),
    termsHash,
    deliveryDeadline,
  })
  tx(flow, `publish job ${jobId}`, receipt)
  return { jobId, termsHash, deliveryDeadline }
}

async function selectAndActivate(flow: string, agentId: bigint, jobId: bigint, termsHash: Hex, activateBy: number) {
  const sel = { jobId, worker: worker.account.address, agentId, termsHash, activateBy, nonce: sdk.randomNonce() }
  const sig = await sdk.signSelection(ctx, creator, sel)
  log(flow, 'creator signed the selection off-chain')
  tx(flow, 'worker activate (own transaction)', await sdk.activate(ctx, worker, sel, sig))
}

async function balances() {
  const [cPay, wPayUsd, wPayEur, cFac, wFac, supply] = await Promise.all([
    sdk.balanceOf(ctx, mEUR, creator.account.address),
    sdk.balanceOf(ctx, mUSD, worker.account.address),
    sdk.balanceOf(ctx, mEUR, worker.account.address),
    sdk.balanceOf(ctx, FACTORY, creator.account.address),
    sdk.balanceOf(ctx, FACTORY, worker.account.address),
    ctx.publicClient.readContract({ address: FACTORY, abi: sdk.factoryTokenAbi, functionName: 'totalSupply' }),
  ])
  return { cPay, wPayUsd, wPayEur, cFac, wFac, supply }
}

// -------------------------------------------------------------------------------------------------
// Flows
// -------------------------------------------------------------------------------------------------

/** publish (mEUR) → selection → worker activates → submit → approver accepts: reward paid, both bonds back. */
async function hire(agentId: bigint) {
  const f = 'hire'
  const before = await balances()
  const { jobId, termsHash, deliveryDeadline } = await publishHire(f, mEUR, 600)
  await selectAndActivate(f, agentId, jobId, termsHash, deliveryDeadline - 60)
  check(f, 'core status after activation = Funded(1)', BigInt((await sdk.getJob(ctx, jobId)).status), 1n)
  tx(f, 'worker submit', await sdk.submit(ctx, worker, jobId, sdk.hashText('deliverable: fork@abc123')))
  tx(f, 'approver accept', await sdk.accept(ctx, creator, jobId))
  const after = await balances()
  check(f, 'worker paid in mEUR', after.wPayEur - before.wPayEur, REWARD)
  check(f, 'worker paid nothing in mUSD', after.wPayUsd - before.wPayUsd, 0n)
  check(f, 'creator FACTORY back (bond returned)', after.cFac - before.cFac, 0n)
  check(f, 'worker FACTORY back (bond returned)', after.wFac - before.wFac, 0n)
}

/** Timely submission, no decision within the 2m review window: anyone completes it; the worker is paid. */
async function silence(agentId: bigint) {
  const f = 'silence'
  const before = await balances()
  const { jobId, termsHash, deliveryDeadline } = await publishHire(f, mEUR, 600)
  await selectAndActivate(f, agentId, jobId, termsHash, deliveryDeadline - 60)
  tx(f, 'worker submit', await sdk.submit(ctx, worker, jobId, sdk.hashText('deliverable: silence')))
  const submittedAt = Number((await sdk.getJob(ctx, jobId)).submittedAt)
  const review = Number(await ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'reviewWindow' }))
  await waitUntilAfter(f, submittedAt + review)
  tx(f, 'relay completeAfterSilence', await sdk.completeAfterSilence(ctx, relay, jobId))
  const after = await balances()
  check(f, 'worker paid', after.wPayEur - before.wPayEur, REWARD)
  check(f, 'bonds back, nothing burned', after.supply - before.supply, 0n)
}

/** reject(quality) → dispute → the arbitrator signs a bad-faith ruling → the relay submits it: paid, creator bond burned. */
async function dispute(agentId: bigint) {
  const f = 'dispute'
  const before = await balances()
  const { jobId, termsHash, deliveryDeadline } = await publishHire(f, mEUR, 600)
  await selectAndActivate(f, agentId, jobId, termsHash, deliveryDeadline - 60)
  tx(f, 'worker submit', await sdk.submit(ctx, worker, jobId, sdk.hashText('deliverable: good work')))
  tx(f, 'approver reject (quality)', await sdk.reject(ctx, creator, jobId, 'Quality', sdk.hashText('reason: tests fail')))
  tx(f, 'worker dispute', await sdk.dispute(ctx, worker, jobId))
  const accepted = await sdk.accept(ctx, creator, jobId).then(
    () => true,
    () => false,
  )
  if (accepted) failures++
  log(f, `${accepted ? '✗' : '✓'} approver cannot accept during the dispute (R114-02)`)
  const ruling = {
    jobId,
    forWorker: true,
    slashLoser: true,
    reasonHash: sdk.hashText('ruling: CI green on the submitted SHA; rejection in bad faith'),
    deadline: BigInt((await now()) + 600),
    nonce: sdk.randomNonce(),
  }
  const sig = await sdk.signRuling(ctx, arbitrator, ruling)
  log(f, 'arbitrator signed the ruling off-chain (sends no transaction)')
  tx(f, 'relay ruleWithSignature', await sdk.ruleWithSignature(ctx, relay, ruling, sig))
  const after = await balances()
  check(f, 'worker paid', after.wPayEur - before.wPayEur, REWARD)
  check(f, 'creator bond burned', before.cFac - after.cFac, CREATOR_BOND)
  check(f, 'FACTORY supply down by the creator bond', before.supply - after.supply, CREATOR_BOND)
  check(f, 'worker bond back', after.wFac - before.wFac, 0n)
}

/** Contest in mUSD: the entrant signs its entry once; the approver awards it; paid in one transaction, winner offline. */
async function contest(agentId: bigint) {
  const f = 'contest'
  const before = await balances()
  const t = await now()
  const { jobId, receipt } = await sdk.publish(ctx, creator, {
    mode: 'contest',
    token: mUSD,
    reward: REWARD,
    creatorBond: CREATOR_BOND,
    workerBond: 0n,
    manifestHash: sdk.hashText('manifest contest'),
    termsHash: sdk.hashText(`contest-${Date.now()}-${sdk.randomNonce()}`),
    deliveryDeadline: t + 600,
    selectionDeadline: t + 300,
  })
  tx(f, `publish contest ${jobId} (prize locked)`, receipt)
  const entry = await sdk.signEntry(ctx, worker, jobId, agentId, sdk.hashText('entry: fork@def456'))
  log(f, 'entrant signed its entry (budget + submit authorisations) and goes offline')
  tx(f, 'approver award', await sdk.award(ctx, creator, jobId, entry))
  check(f, 'core status = Completed(3)', BigInt((await sdk.getJob(ctx, jobId)).status), 3n)
  const after = await balances()
  check(f, 'winner paid in mUSD', after.wPayUsd - before.wPayUsd, REWARD)
  check(f, 'creator bond back', after.cFac - before.cFac, 0n)
}

/** Funded no-show: after the delivery deadline anyone burns the whole worker bond; the reward refunds. */
async function noshow(agentId: bigint) {
  const f = 'noshow'
  const before = await balances()
  const { jobId, termsHash, deliveryDeadline } = await publishHire(f, mEUR, 90)
  await selectAndActivate(f, agentId, jobId, termsHash, deliveryDeadline - 30)
  await waitUntilAfter(f, deliveryDeadline)
  tx(f, 'relay missed-delivery burn', await sdk.burnMissedDelivery(ctx, relay, jobId))
  tx(f, 'relay settle (refund to the creator)', await sdk.settle(ctx, relay, jobId))
  const after = await balances()
  check(f, 'worker bond burned', before.wFac - after.wFac, WORKER_BOND)
  check(f, 'FACTORY supply down by the worker bond', before.supply - after.supply, WORKER_BOND)
  check(f, 'creator refunded in full', after.cPay - before.cPay, 0n)
  check(f, 'creator bond back', after.cFac - before.cFac, 0n)
  check(f, 'worker unpaid', after.wPayEur - before.wPayEur, 0n)
}

/** Settles what a terminal job left in Holding (the refunded reward, bonds no evaluator path settled). */
async function settle(f: string, jobId: bigint) {
  tx(f, 'relay settle', await sdk.settle(ctx, relay, jobId))
}

/** A hire cancelled before anyone activates: reward and creator bond come back via settle; nothing burns. */
async function cancel(agentId: bigint) {
  const f = 'cancel'
  const before = await balances()
  const { jobId, termsHash, deliveryDeadline } = await publishHire(f, mEUR, 600)
  // A signed selection the worker never used: the creator burns its nonce, so it can never activate.
  const sel = { jobId, worker: worker.account.address, agentId, termsHash, activateBy: deliveryDeadline - 60, nonce: sdk.randomNonce() }
  const sig = await sdk.signSelection(ctx, creator, sel)
  tx(f, 'creator cancelSelection (burns the signed nonce)', await sdk.cancelSelection(ctx, creator, sel.nonce))
  const activated = await sdk.activate(ctx, worker, sel, sig).then(() => true, () => false)
  if (activated) failures++
  log(f, `${activated ? '✗' : '✓'} the revoked selection cannot activate`)
  tx(f, 'creator cancel', await sdk.cancel(ctx, creator, jobId))
  await settle(f, jobId)
  const after = await balances()
  check(f, 'creator refunded in full', after.cPay - before.cPay, 0n)
  check(f, 'creator bond back', after.cFac - before.cFac, 0n)
  check(f, 'nothing burned', after.supply - before.supply, 0n)
}

/** A contest nobody awarded by its selection deadline: anyone expires it; prize and creator bond come back. */
async function unpicked(_agentId: bigint) {
  const f = 'unpicked'
  const before = await balances()
  const beforeUsd = await sdk.balanceOf(ctx, mUSD, creator.account.address)
  const t = await now()
  const { jobId, receipt } = await sdk.publish(ctx, creator, {
    mode: 'contest',
    token: mUSD,
    reward: REWARD,
    creatorBond: CREATOR_BOND,
    workerBond: 0n,
    manifestHash: sdk.hashText('manifest unpicked contest'),
    termsHash: sdk.hashText(`unpicked-${Date.now()}-${sdk.randomNonce()}`),
    deliveryDeadline: t + 600,
    selectionDeadline: t + 60,
  })
  tx(f, `publish contest ${jobId}`, receipt)
  await waitUntilAfter(f, t + 60)
  tx(f, 'relay expireContest', await sdk.expireContest(ctx, relay, jobId))
  await settle(f, jobId)
  const after = await balances()
  check(f, 'creator prize back (mUSD)', (await sdk.balanceOf(ctx, mUSD, creator.account.address)) - beforeUsd, 0n)
  check(f, 'creator bond back', after.cFac - before.cFac, 0n)
  check(f, 'nothing burned', after.supply - before.supply, 0n)
}

/** reject(violation) that nobody disputes: after the dispute window anyone finalises it. Quality burns the worker
 *  bond; None returns both. The reward refunds to the creator. */
async function lapse(agentId: bigint, violation: 'Quality' | 'None' = 'Quality') {
  const f = violation === 'None' ? 'lapse-none' : 'lapse'
  const before = await balances()
  const { jobId, termsHash, deliveryDeadline } = await publishHire(f, mEUR, 600)
  await selectAndActivate(f, agentId, jobId, termsHash, deliveryDeadline - 60)
  tx(f, 'worker submit', await sdk.submit(ctx, worker, jobId, sdk.hashText(`deliverable: ${f}`)))
  tx(f, `approver reject (${violation})`, await sdk.reject(ctx, creator, jobId, violation, sdk.hashText(`reason: ${f}`)))
  const at = Number(await ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'rejectedAt', args: [jobId] }))
  const window = Number(await ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'disputeWindow' }))
  await waitUntilAfter(f, at + window)
  tx(f, 'relay rejectAfterWindow', await sdk.rejectAfterWindow(ctx, relay, jobId))
  await settle(f, jobId)
  const after = await balances()
  check(f, 'creator refunded in full', after.cPay - before.cPay, 0n)
  check(f, 'worker unpaid', after.wPayEur - before.wPayEur, 0n)
  check(f, 'creator bond back', after.cFac - before.cFac, 0n)
  check(f, violation === 'None' ? 'worker bond back (None names no violation)' : 'worker bond burned', before.wFac - after.wFac, violation === 'None' ? 0n : WORKER_BOND)
}

const lapseNone = (agentId: bigint) => lapse(agentId, 'None')

/** A dispute the arbitrator never rules on: after the arbitration window anyone refunds; both bonds back. */
async function timeout(agentId: bigint) {
  const f = 'timeout'
  const before = await balances()
  const { jobId, termsHash, deliveryDeadline } = await publishHire(f, mEUR, 900)
  await selectAndActivate(f, agentId, jobId, termsHash, deliveryDeadline - 60)
  tx(f, 'worker submit', await sdk.submit(ctx, worker, jobId, sdk.hashText('deliverable: timeout')))
  tx(f, 'approver reject (Quality)', await sdk.reject(ctx, creator, jobId, 'Quality', sdk.hashText('reason: timeout')))
  tx(f, 'worker dispute', await sdk.dispute(ctx, worker, jobId))
  const at = Number(await ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'disputedAt', args: [jobId] }))
  const window = Number(await ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'arbitrationWindow' }))
  await waitUntilAfter(f, at + window)
  tx(f, 'relay refundAfterArbitrationTimeout', await sdk.refundAfterArbitrationTimeout(ctx, relay, jobId))
  await settle(f, jobId)
  const after = await balances()
  check(f, 'creator refunded in full', after.cPay - before.cPay, 0n)
  // By balance, not supply: other wallets may use the testnet faucet meanwhile.
  check(f, 'creator bond back', after.cFac - before.cFac, 0n)
  check(f, 'worker bond back', after.wFac - before.wFac, 0n)
}

/** reject(Falsified) → dispute → signed ruling for the creator with slash: refund, worker bond burned. */
async function falsified(agentId: bigint) {
  const f = 'falsified'
  const before = await balances()
  const { jobId, termsHash, deliveryDeadline } = await publishHire(f, mEUR, 600)
  await selectAndActivate(f, agentId, jobId, termsHash, deliveryDeadline - 60)
  tx(f, 'worker submit', await sdk.submit(ctx, worker, jobId, sdk.hashText('deliverable: claims tests that do not exist')))
  tx(f, 'approver reject (Falsified)', await sdk.reject(ctx, creator, jobId, 'Falsified', sdk.hashText('reason: the evidence is fabricated')))
  tx(f, 'worker dispute', await sdk.dispute(ctx, worker, jobId))
  const ruling = {
    jobId,
    forWorker: false,
    slashLoser: true,
    reasonHash: sdk.hashText('ruling: the claimed CI run does not exist for the submitted SHA'),
    deadline: BigInt((await now()) + 600),
    nonce: sdk.randomNonce(),
  }
  const sig = await sdk.signRuling(ctx, arbitrator, ruling)
  tx(f, 'relay ruleWithSignature (for the creator, slash)', await sdk.ruleWithSignature(ctx, relay, ruling, sig))
  const replay = await sdk.ruleWithSignature(ctx, relay, ruling, sig).then(() => true, () => false)
  if (replay) failures++
  log(f, `${replay ? '✗' : '✓'} the same signed ruling cannot be replayed`)
  await settle(f, jobId)
  const after = await balances()
  check(f, 'creator refunded in full', after.cPay - before.cPay, 0n)
  check(f, 'worker bond burned', before.wFac - after.wFac, WORKER_BOND)
  check(f, 'creator bond back', after.cFac - before.cFac, 0n)
}

const all = { hire, silence, dispute, contest, noshow, cancel, unpicked, lapse, 'lapse-none': lapseNone, timeout, falsified } as const
type FlowName = keyof typeof all

async function main() {
  const arg = process.argv[2] ?? 'all'
  const names = (arg === 'all' ? Object.keys(all) : arg.split(',')) as FlowName[]
  for (const n of names) if (!(n in all)) throw new Error(`unknown flow ${n}`)
  const agentId = await setup()
  // Sequential: flows share the creator's and worker's balances, which each flow checks by difference.
  for (const n of names) {
    console.log(`\n=== ${n} ===`)
    await all[n](agentId)
  }
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
