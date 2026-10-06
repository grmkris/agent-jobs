/**
 * Execution budgets live on Monad testnet (ADR-0009), through the hosted board: two demo-stack hires from the Privy
 * server wallet as creator and a campaign wallet as worker.
 *
 * 1. An advance of 2 mEUR. Publishing goes out as one EIP-7702 batch, which points the Privy wallet at the DeleGator.
 *    Before the grant the board refuses a draw. The creator signs the delegation through Privy. The worker draws
 *    1 mEUR through the board, is refused 1.5 more, then redeems 0.5 itself with `cast` (the worker skill's recipe),
 *    which the board mirrors. The creator revokes and sends `disableDelegation`; the next draw is refused, and a
 *    direct redeem reverts.
 * 2. A call budget: one `faucet()` on mUSD from the creator's account, value 0. The creator's mUSD grows; a second
 *    call is refused by the board and reverts on-chain.
 *
 *   BOARD_URL=https://dev.sidequest.exchange bun packages/sdk/scripts/board-budget.ts   (from the repo root)
 *
 * Keys from .env.local: PRIVY_APP_ID / PRIVY_APP_SECRET / PRIVY_SERVER_WALLET_ID / PRIVY_SERVER_WALLET_ADDRESS
 * (creator), CAMPAIGN_CLAUDE_PRIVATE_KEY / CAMPAIGN_CLAUDE_AGENT_ID (worker), MONAD_TESTNET_RPC_URL.
 */
import { execFileSync } from 'node:child_process'
import { type Address, type Hex, concat, erc20Abi, pad, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'
import { check, checks, envLocal, log as stamp, sendReported } from './lib/common.ts'

const BOARD = envLocal('BOARD_URL', 'https://dev.sidequest.exchange')
const RPC = envLocal('MONAD_TESTNET_RPC_URL')
const ctx = sdk.context('monad-testnet', 'demo', RPC)
const D = ctx.deployment.delegation
const [mUSD, mEUR] = ctx.deployment.rewardTokens as [Address, Address]
const log = (m: string) => stamp('budget', m)

const creator = sdk.privyWallet(
  'monad-testnet',
  {
    appId: envLocal('PRIVY_APP_ID'),
    appSecret: envLocal('PRIVY_APP_SECRET'),
    walletId: envLocal('PRIVY_SERVER_WALLET_ID'),
    address: envLocal('PRIVY_SERVER_WALLET_ADDRESS') as Address,
  },
  RPC,
)
const workerKey = envLocal('CAMPAIGN_CLAUDE_PRIVATE_KEY') as Hex
const workerAccount = privateKeyToAccount(workerKey)
const worker = sdk.wallet('monad-testnet', workerAccount, RPC)
const agentId = envLocal('CAMPAIGN_CLAUDE_AGENT_ID')
const me = creator.account.address
const pub = sdk.boardClient(BOARD)
const wrk = sdk.boardClient(BOARD)

const balance = (token: Address, of: Address) => ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [of] })

/** The board's refusal message, or null when the call went through. */
async function refusal(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (e) {
    return (e as Error).message
  }
}

/** A hire on the demo stack with this budget, published in one batch, applied for, selected and activated. */
async function activeHire(title: string, executionBudget: Record<string, unknown>): Promise<{ taskId: string; jobId: string }> {
  const now = Math.floor(Date.now() / 1000)
  const created = await pub.call('create_task', {
    title,
    brief: 'A live check of ADR-0009 execution budgets. Nothing needs delivering; the job is left to expire.',
    acceptanceCriteria: ['None: this job exists to exercise its execution budget.'],
    token: 'mUSD',
    reward: '1',
    creatorBond: '0',
    workerBond: '0',
    deliveryDeadline: now + 90 * 60,
    mode: 'hire',
    stack: 'demo',
    executionBudget,
  })
  const taskId = created.taskId as string
  await sendReported(pub, creator, ctx.publicClient, taskId, created.transactions, 'creator', D.delegator)
  const app = await wrk.call('apply', { taskId, agentId, note: 'budget live check' })
  const sel = await pub.call('select_worker', { taskId, applicationId: app.applicationId })
  await pub.call('submit_selection', { taskId, nonce: sel.nonce, signature: await sdk.signTypedDataJson(creator, sel.sign.typedData) })
  const prep = await wrk.call('prepare_activation', { taskId })
  const act = await wrk.call('build_activation', { taskId, budgetSignature: await sdk.signTypedDataJson(worker, prep.sign.typedData) })
  await sendReported(wrk, worker, ctx.publicClient, taskId, act.transactions, 'worker', D.delegator)
  const t = await pub.call('get_task', { taskId })
  check(`${title}: job ${t.jobId} active`, t.chain.status === 'active', t.chain.status)
  return { taskId, jobId: String(t.jobId) }
}

/** The creator's grant: any upgrade first (a type-4 call to self with an empty batch), then the delegation signature. */
async function grant(taskId: string) {
  const prep = await pub.call('budget_grant_prepare', { taskId })
  if (prep.upgrade !== null) {
    const h = await sdk.sendBatch(creator, ctx.publicClient, [], D.delegator)
    await ctx.publicClient.waitForTransactionReceipt({ hash: h as Hex })
    log(`creator upgraded to the DeleGator → https://testnet.monadscan.com/tx/${h}`)
  }
  await pub.call('budget_grant_confirm', { taskId, signature: await sdk.signTypedDataJson(creator, prep.sign.typedData) })
  return prep
}

/**
 * A redemption without the board, exactly as the worker skill writes it: the permission context from `get_budget`'s
 * delegation, single mode, the packed execution. Returns the transaction hash, or the revert text.
 */
function castRedeem(delegation: any, target: Address, callData: Hex): { hash: Hex } | { error: string } {
  const caveats = (delegation.caveats as Array<{ enforcer: string; terms: string; args: string }>).map((c) => `(${c.enforcer},${c.terms},${c.args})`).join(',')
  const tuple = `[(${delegation.delegate},${delegation.delegator},${delegation.authority},[${caveats}],${delegation.salt},${delegation.signature})]`
  const ctxArg = execFileSync('cast', ['abi-encode', 'f((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)[])', tuple], { encoding: 'utf8' }).trim()
  const exec = concat([target, pad(toHex(0n), { size: 32 }), callData])
  try {
    const out = execFileSync(
      'cast',
      ['send', D.manager, 'redeemDelegations(bytes[],bytes32[],bytes[])', `[${ctxArg}]`, `[${pad(toHex(0n), { size: 32 })}]`, `[${exec}]`, '--private-key', workerKey, '--rpc-url', RPC, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const r = JSON.parse(out) as { transactionHash: Hex; status: string }
    return r.status === '0x1' ? { hash: r.transactionHash } : { error: `reverted in ${r.transactionHash}` }
  } catch (e) {
    const text = String((e as { stderr?: string }).stderr ?? e)
    return { error: /execution reverted[^\n]*/.exec(text)?.[0].slice(0, 160) ?? text.slice(0, 160) }
  }
}

const transfer = (to: Address, amount: bigint) =>
  concat(['0xa9059cbb', pad(to, { size: 32 }), pad(toHex(amount), { size: 32 })])

await pub.signIn(sdk.signerOf(creator) as never)
await wrk.signIn(workerAccount)
log(`creator (Privy server wallet) ${me}, worker ${workerAccount.address} (agent ${agentId}), board ${BOARD}`)
const info = await pub.call('protocol_info', {})
check('protocol_info names the DeleGator and the DelegationManager', info.contracts.delegator === D.delegator && info.contracts.delegationManager === D.manager)

// 1. The advance.
const A = await activeHire('Execution budget live check: an advance of 2 mEUR', { kind: 'advance', token: 'mEUR', cap: '2' })
check('the creator’s account points at the DeleGator after its first batch', (await sdk.delegationOf(ctx.publicClient, me))?.toLowerCase() === D.delegator.toLowerCase())
const early = await refusal(wrk.call('spend_budget', { taskId: A.taskId, amount: '1' }))
check('a draw before the grant is refused', early?.includes('not granted') === true, early ?? 'went through')
await grant(A.taskId)
let b = await pub.call('get_budget', { taskId: A.taskId })
check('granted: live, on-chain delegation', b.status === 'live' && b.redeemable === true, `${b.status} ${b.enforcement}`)

const [creatorBefore, workerBefore] = [await balance(mEUR, me), await balance(mEUR, workerAccount.address)]
const d1 = await wrk.call('spend_budget', { taskId: A.taskId, amount: '1', note: 'model calls' })
await sendReported(wrk, worker, ctx.publicClient, A.taskId, d1.transactions, 'worker')
check('1 mEUR moved from the creator to the worker', (await balance(mEUR, me)) === creatorBefore - 1_000_000n && (await balance(mEUR, workerAccount.address)) === workerBefore + 1_000_000n)
const over = await refusal(wrk.call('spend_budget', { taskId: A.taskId, amount: '1.5' }))
check('1.5 more is refused by the board', over?.includes('over the budget: 1 left of 2') === true, over ?? 'went through')

b = await wrk.call('get_budget', { taskId: A.taskId })
const direct = castRedeem(b.delegation.delegation, mEUR, transfer(workerAccount.address, 500_000n))
check('the worker redeems 0.5 mEUR itself with cast', 'hash' in direct, 'hash' in direct ? direct.hash : direct.error)
if ('hash' in direct) {
  log(`direct redeem → https://testnet.monadscan.com/tx/${direct.hash}`)
  await wrk.call('report_transaction', { taskId: A.taskId, txHash: direct.hash })
}
b = await pub.call('get_budget', { taskId: A.taskId })
check('the board mirrors it: drawn 1.5, remaining 0.5', b.drawn === '1.5' && b.remaining === '0.5', `${b.drawn} / ${b.remaining}`)
check('draws: one prepared by the board, one without it', b.draws.length === 2 && b.draws[1].note === 'redeemed without the board', JSON.stringify(b.draws.map((x: any) => [x.amount, x.status, x.note])))

const rv = await pub.call('revoke_budget', { taskId: A.taskId })
await sendReported(pub, creator, ctx.publicClient, A.taskId, rv.transactions, 'creator')
b = await pub.call('get_budget', { taskId: A.taskId })
check('revoked: the board says so and the chain no longer honours it', b.status === 'revoked' && b.redeemable === false, `${b.status} redeemable=${b.redeemable}`)
const afterRevoke = await refusal(wrk.call('spend_budget', { taskId: A.taskId, amount: '0.1' }))
check('a draw after the revoke is refused by the board', afterRevoke?.includes('revoked') === true, afterRevoke ?? 'went through')
const stale = castRedeem(b.delegation.delegation, mEUR, transfer(workerAccount.address, 100_000n))
// 0x05baa052 is DelegationManager's CannotUseADisabledDelegation().
check('a direct redeem after disableDelegation reverts: CannotUseADisabledDelegation', 'error' in stale && stale.error.includes('0x05baa052'), 'error' in stale ? stale.error : stale.hash)

// 2. The call budget: faucet() on mUSD from the creator's account.
const C = await activeHire('Execution budget live check: one faucet() call', { kind: 'call', target: mUSD, function: 'function faucet()', cap: '0' })
const cp = await grant(C.taskId)
check('the second grant needs no upgrade', cp.upgrade === null)
const usdBefore = await balance(mUSD, me)
const c1 = await wrk.call('spend_budget_call', { taskId: C.taskId, data: '0xde5f72fd', note: 'faucet for the creator' })
await sendReported(wrk, worker, ctx.publicClient, C.taskId, c1.transactions, 'worker')
const usdAfter = await balance(mUSD, me)
check('faucet() ran as the creator: its mUSD grew', usdAfter > usdBefore, `${usdBefore} → ${usdAfter}`)
b = await pub.call('get_budget', { taskId: C.taskId })
check('get_budget counts the one call', b.calls?.made === 1 && b.draws[0]?.status === 'confirmed', JSON.stringify(b.calls))
const again = await refusal(wrk.call('spend_budget_call', { taskId: C.taskId, data: '0xde5f72fd' }))
check('a second call is refused by the board', again?.includes('already made') === true, again ?? 'went through')
const second = castRedeem(b.delegation.delegation, mUSD, '0xde5f72fd')
check('a second call redeemed directly reverts: LimitedCallsEnforcer:limit-exceeded', 'error' in second && second.error.includes('limit-exceeded'), 'error' in second ? second.error : second.hash)

console.log(`ADVANCE_TASK=${A.taskId} ADVANCE_JOB=${A.jobId} CALL_TASK=${C.taskId} CALL_JOB=${C.jobId}`)
checks.done()
