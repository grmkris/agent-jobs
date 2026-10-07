import { erc20Abi } from 'viem'
/**
 * EIP-7702 batches through the hosted board, live on Monad testnet (demo board): every multi-transaction step goes
 * out as one transaction through the MetaMask DeleGator (ERC-7579 `execute`), and the board confirms each operation from the
 * batch's receipt.
 *
 * 1. The testnet creator (cast key) publishes a hire: approve reward + approve SIDE + publish in one transaction;
 *    then cancels it: cancel + settle in one.
 * 2. The Privy server wallet does the same publish (its key is in Privy: Privy signs the authorization).
 * 3. A hire the testnet worker takes: it signs its budget authorization first, then sends approve + activate as one.
 *
 *   BOARD_URL=https://… [WORKER_KEY_VAR=CAMPAIGN_GROK_PRIVATE_KEY] bun packages/sdk/scripts/board-batch.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'
import { check, checks, env, log, sendReported } from './lib/common.ts'

const BOARD = env('BOARD_URL')
const RPC = env('MONAD_TESTNET_RPC_URL')
const ctx = sdk.context('monad-testnet', 'demo', RPC)
const D = ctx.deployment.delegation.delegator
const creatorAccount = privateKeyToAccount(env('TESTNET_CREATOR_PRIVATE_KEY') as Hex)
// WORKER_KEY_VAR picks another worker key from .env.local (its agent id from the matching *_AGENT_ID).
const WORKER_KEY_VAR = env('WORKER_KEY_VAR', 'TESTNET_WORKER_PRIVATE_KEY')
const workerAccount = privateKeyToAccount(env(WORKER_KEY_VAR) as Hex)
const creator = sdk.wallet('monad-testnet', creatorAccount, RPC)
const worker = sdk.wallet('monad-testnet', workerAccount, RPC)
const agentId = WORKER_KEY_VAR === 'TESTNET_WORKER_PRIVATE_KEY'
  ? (JSON.parse(readFileSync(join(import.meta.dirname, '.state.json'), 'utf8')) as { workerAgentId: string }).workerAgentId
  : env(WORKER_KEY_VAR.replace(/_PRIVATE_KEY$/, '_AGENT_ID'))
const txCount = async (h: string) => (await ctx.publicClient.getTransactionReceipt({ hash: h as Hex })).transactionHash === h ? 1 : 0

async function offer(title: string) {
  const now = Number((await ctx.publicClient.getBlock()).timestamp)
  return {
    title,
    brief: 'EIP-7702 batch rehearsal: add CI to https://github.com/grmkris/runner-spike-fixture.',
    acceptanceCriteria: ['A GitHub check run named "test" completes with conclusion "success" on the submitted SHA.'],
    token: 'mUSD',
    reward: '1',
    creatorBond: '1',
    workerBond: '1',
    deliveryDeadline: now + 3600,
    mode: 'hire',
    stack: 'demo',
    requiredChecks: ['test'],
  }
}

async function publishBatched(who: string, w: sdk.Wallet, board: ReturnType<typeof sdk.boardClient>, title: string) {
  const created = await board.call('create_task', await offer(title))
  check(`${who}: the board returned several transactions to publish`, created.transactions.length > 1, `${created.transactions.length}`)
  const hashes = await sendReported(board, w, ctx.publicClient, created.taskId, created.transactions, who, D)
  check(`${who}: published in one transaction`, hashes.length === 1 && (await txCount(hashes[0] as string)) === 1)
  const t = await board.call('get_task', { taskId: created.taskId })
  check(`${who}: board confirmed the publish from the batch receipt`, t.jobId !== null && t.chain.status === 'open', `job ${t.jobId} ${t.chain.status}`)
  const code = await ctx.publicClient.getCode({ address: w.account.address })
  check(`${who}: account now delegates to the DeleGator`, code?.toLowerCase() === `0xef0100${D.slice(2).toLowerCase()}`)
  return created.taskId as string
}

// 1. cast key: publish, then cancel + settle, each one transaction.
const pub = sdk.boardClient(BOARD)
await pub.signIn(creatorAccount)
const t1 = await publishBatched('creator', creator, pub, 'Batch rehearsal: publish and cancel')
const cancel = await pub.call('cancel_task', { taskId: t1 })
check('creator: cancel is cancel + settle', cancel.transactions.length === 2)
const c = await sendReported(pub, creator, ctx.publicClient, t1, cancel.transactions, 'creator', D)
check('creator: cancelled and settled in one transaction', c.length === 1)
check('creator: the job is cancelled', (await pub.call('get_task', { taskId: t1 })).chain.status === 'cancelled')

// 2. Privy server wallet: the same publish, authorization signed by Privy.
if ((process.env.PRIVY_SERVER_WALLET_ID ?? '') !== '') {
  const privy = sdk.privyWallet('monad-testnet', {
    appId: env('PRIVY_APP_ID'),
    appSecret: env('PRIVY_APP_SECRET'),
    walletId: env('PRIVY_SERVER_WALLET_ID'),
    address: env('PRIVY_SERVER_WALLET_ADDRESS') as Address,
  }, RPC)
  const pb = sdk.boardClient(BOARD)
  await pb.signIn(sdk.signerOf(privy) as never)
  const t2 = await publishBatched('privy', privy, pb, 'Batch rehearsal: Privy server wallet publish')
  const cx = await pb.call('cancel_task', { taskId: t2 })
  await sendReported(pb, privy, ctx.publicClient, t2, cx.transactions, 'privy', D)
}

// 3. A hire: the worker signs first, then sends approve + activate as one transaction.
const wrk = sdk.boardClient(BOARD)
await wrk.signIn(workerAccount)
const t3 = await publishBatched('creator', creator, pub, 'Batch rehearsal: activate in one transaction')
const app = await wrk.call('apply', { taskId: t3, agentId, note: 'batch rehearsal' })
const sel = await pub.call('select_worker', { taskId: t3, applicationId: app.applicationId })
await pub.call('submit_selection', { taskId: t3, nonce: sel.nonce, signature: await sdk.signTypedDataJson(creator, sel.sign.typedData) })
const prep = await wrk.call('prepare_activation', { taskId: t3 })
const act = await wrk.call('build_activation', { taskId: t3, budgetSignature: await sdk.signTypedDataJson(worker, prep.sign.typedData) })
// The bond approval is included only when the worker's allowance does not cover it yet.
const allowance = await ctx.publicClient.readContract({ address: ctx.deployment.factory, abi: erc20Abi, functionName: 'allowance', args: [workerAccount.address, ctx.stack.holding] })
check('worker: build_activation returns activate, preceded by the approval only if missing', act.transactions.length === (allowance >= 10n ** 18n ? 1 : 2), act.transactions.map((t: sdk.TxRequest) => t.description.split(':')[0]).join(', '))
const a = await sendReported(wrk, worker, ctx.publicClient, t3, act.transactions, 'worker', D)
check('worker: activated in one transaction', a.length === 1)
check('worker: the job is active', (await wrk.call('get_task', { taskId: t3 })).chain.status === 'active')
log('note', `task ${t3} stays active on the demo board; its delivery deadline expires it (settlement_actions pairs the timeout with settle)`)
checks.done()
