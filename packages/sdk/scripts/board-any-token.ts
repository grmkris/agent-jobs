/**
 * ADR-0010 live: a hire whose reward is an ERC-20 the deployment has never heard of, end to end through the hosted
 * board. The testnet creator publishes it on the main pair (the one marked `openTokens`), agent CAMPAIGN_GROK applies,
 * activates, submits a URL, and is paid in that token; before that the board refuses the same token on the demo pair
 * (its Holding predates open tokens) and refuses a bare symbol it does not know.
 *
 *   TOKEN=0x… bun packages/sdk/scripts/board-any-token.ts   (from the repo root; .env.local is read)
 *
 * TOKEN must answer symbol() and decimals(); if it has a `faucet()` (e.g. a MockPaymentToken) the creator taps it when
 * short. BOARD_URL defaults to https://dev.sidequest.exchange; REWARD (default 5) in token units. Bonds are 0.
 */
import { type Address, type Hex, formatUnits, getAddress, parseAbi, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'
import { check, checks, envLocal, log, sendReported, txUrl } from './lib/common.ts'

const BOARD = envLocal('BOARD_URL', 'https://dev.sidequest.exchange')
const RPC = envLocal('MONAD_TESTNET_RPC_URL')
const TOKEN = getAddress(envLocal('TOKEN'))
const REWARD = envLocal('REWARD', '5')
const ctx = sdk.context('monad-testnet', 'main', RPC)
const creatorAccount = privateKeyToAccount(envLocal('TESTNET_CREATOR_PRIVATE_KEY') as Hex)
const workerAccount = privateKeyToAccount(envLocal('CAMPAIGN_GROK_PRIVATE_KEY') as Hex)
const creator = sdk.wallet('monad-testnet', creatorAccount, RPC)
const worker = sdk.wallet('monad-testnet', workerAccount, RPC)
const agentId = envLocal('CAMPAIGN_GROK_AGENT_ID')
const asCreator = sdk.boardClient(BOARD)
const asWorker = sdk.boardClient(BOARD)
const erc20 = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)', 'function faucet()'])
const read = <T>(functionName: 'symbol' | 'decimals' | 'balanceOf', args: readonly [Address] | [] = []) =>
  ctx.publicClient.readContract({ address: TOKEN, abi: erc20, functionName, args } as never) as Promise<T>

const [symbol, decimals] = await Promise.all([read<string>('symbol'), read<number>('decimals')])
const reward = parseUnits(REWARD, decimals)
check('the token is not one the deployment lists', !ctx.deployment.rewardTokens.some((t) => t.toLowerCase() === TOKEN.toLowerCase()), `${symbol} ${TOKEN}`)
check('the main pair is marked openTokens', ctx.stack.openTokens)

if ((await read<bigint>('balanceOf', [creatorAccount.address])) < reward) {
  const hash = await creator.writeContract({ address: TOKEN, abi: erc20, functionName: 'faucet' })
  await ctx.publicClient.waitForTransactionReceipt({ hash })
  log('publisher', `faucet ${symbol} → ${txUrl(hash)}`)
}

await asCreator.signIn(creatorAccount)
await asWorker.signIn(workerAccount)
const now = Math.floor(Date.now() / 1000)
const offer = {
  title: `Paid in ${symbol}, a token nobody listed`,
  brief: `ADR-0010 proof: the reward is ${symbol} (${TOKEN}), an ERC-20 deployed for this test and never registered anywhere. Deliver any URL.`,
  acceptanceCriteria: ['A URL is submitted.'],
  deliverable: { accepts: ['url'] },
  token: TOKEN,
  reward: REWARD,
  creatorBond: '0',
  workerBond: '0',
  deliveryDeadline: now + 50 * 60,
  mode: 'hire',
}
const refused = async (what: string, args: Record<string, unknown>, expected: RegExp) => {
  const message = await asCreator.call('create_task', args).then(() => 'accepted', (e: Error) => e.message)
  check(what, expected.test(message), message)
}
await refused('the demo pair refuses it: its Holding predates open tokens', { ...offer, stack: 'demo' }, /predates open tokens/)
await refused('a symbol the deployment does not list is refused', { ...offer, token: symbol, stack: 'main' }, /by its address/)

const created = await asCreator.call<{ taskId: string; transactions: sdk.TxRequest[] }>('create_task', { ...offer, stack: 'main' })
const taskId = created.taskId
await sendReported(asCreator, creator, ctx.publicClient, taskId, created.transactions, 'publisher')
const listed = await asCreator.call('get_task', { taskId })
check(`published on main as job ${listed.jobId}`, listed.chain.status === 'open' && listed.chain.listingMatchesOffer === true, `status ${listed.chain.status}`)

const app = await asWorker.call<{ applicationId: string }>('apply', { taskId, agentId, note: `I accept ${symbol}.` })
const sel = await asCreator.call('select_worker', { taskId, applicationId: app.applicationId })
await asCreator.call('submit_selection', { taskId, nonce: sel.nonce, signature: await sdk.signTypedDataJson(creator, sel.sign.typedData) })
const prep = await asWorker.call<{ transactions: sdk.TxRequest[]; sign: { typedData: unknown } }>('prepare_activation', { taskId })
await sendReported(asWorker, worker, ctx.publicClient, taskId, prep.transactions, 'worker')
const act = await asWorker.call<{ transactions: sdk.TxRequest[] }>('build_activation', { taskId, budgetSignature: await sdk.signTypedDataJson(worker, prep.sign.typedData as never) })
await sendReported(asWorker, worker, ctx.publicClient, taskId, act.transactions, 'worker')
const sub = await asWorker.call<{ transactions: sdk.TxRequest[] }>('submit_work', { taskId, deliverable: { kind: 'url', url: 'https://github.com/grmkris/sidequest/blob/main/docs/decisions/0010-permissionless-tokens.md' } })
await sendReported(asWorker, worker, ctx.publicClient, taskId, sub.transactions, 'worker')

const before = await read<bigint>('balanceOf', [workerAccount.address])
const approve = await asCreator.call<{ transactions: sdk.TxRequest[] }>('approve_work', { taskId })
await sendReported(asCreator, creator, ctx.publicClient, taskId, approve.transactions, 'publisher')
const paid = (await read<bigint>('balanceOf', [workerAccount.address])) - before
check(`the worker was paid ${REWARD} ${symbol}`, paid === reward, `${formatUnits(paid, decimals)} ${symbol}`)
const final = await asCreator.call('get_task', { taskId })
check('the job completed', final.chain.status === 'completed', final.chain.status)
console.log(`TASK_ID=${taskId} JOB_ID=${listed.jobId}`)
checks.done()
