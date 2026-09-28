/**
 * Demo step 1 on testnet through the Dispatch adapter (`sdk.dispatchPublisher`): a Cloudflare OS Dispatch task is
 * published to agent-jobs as a quote request by the OS's wallet (the Privy server wallet: the OS holds no key), the
 * OS owner picks a bidder's quote, which publishes the escrowed hire and selects the bidder, and later decides after
 * its own review.
 *
 *   MODE=publish BOARD_URL=… APPLICANT=0x… bun packages/sdk/scripts/dispatch-demo.ts      (from the repo root)
 *   MODE=decide  BOARD_URL=… TASK_ID=… DECISION=accept|reject [VIOLATION=… REASON=…] bun packages/sdk/scripts/dispatch-demo.ts
 *
 * The Dispatch task below is the shape `DispatchSession.createTask` stores in Cloudflare OS; in the OS it comes from
 * the owner's chat, here it is inlined so the agent-jobs side runs without the OS checkout.
 */
import type { Address } from 'viem'
import * as sdk from '../src/index.ts'
import { env, log as stamp, sleep } from './lib/common.ts'

const RPC = env('MONAD_TESTNET_RPC_URL')
const ctx = sdk.context('monad-testnet', 'main', RPC)
const os = sdk.privyWallet('monad-testnet', {
  appId: env('PRIVY_APP_ID'),
  appSecret: env('PRIVY_APP_SECRET'),
  walletId: env('PRIVY_SERVER_WALLET_ID'),
  address: env('PRIVY_SERVER_WALLET_ADDRESS') as Address,
}, RPC)
const log = (m: string) => stamp('dispatch', m)

const task: sdk.DispatchTask = {
  id: 't000042',
  title: 'Roman numerals both ways (from a Cloudflare OS Dispatch board)',
  description: 'Implement toRoman and fromRoman as specified in the README: canonical numerals 1 to 3999, RangeError and SyntaxError for everything else, and a full round trip.',
  repo: { url: 'https://github.com/grmkris/aj-bounty-roman', baseBranch: 'main' },
  acceptance: ['The existing tests under test/ are unchanged: none edited or deleted.'],
}
const policy: sdk.DispatchPolicy = { tokens: ['mUSD', 'mEUR'], creatorBond: '2', workerBond: '1', deliveryHours: 2.5, quoteHours: 0.5, requiredChecks: ['test'], stack: 'main' }

const pub = await sdk.dispatchPublisher(env('BOARD_URL'), os, ctx.publicClient, process.env.BATCH === '0' ? {} : { batchDelegate: ctx.deployment.batchDelegate })
log(`signed in as the OS wallet ${os.account.address} (Privy)`)

if (env('MODE') === 'publish') {
  // Enough of every token for any quote up to 100 (the testnet faucet gives 1000 per call).
  for (const token of [ctx.deployment.factory, ...ctx.deployment.rewardTokens]) {
    if ((await sdk.balanceOf(ctx, token, os.account.address)) < 100n * 10n ** 18n / (token === ctx.deployment.factory ? 1n : 10n ** 12n)) {
      log(`faucet ${token}: ${(await sdk.faucet(ctx, os, token)).transactionHash}`)
    }
  }
  const requestId = process.env.REQUEST_ID ?? (await pub.requestQuotes(task, policy)).requestId
  log(`quote request ${requestId} for Dispatch task ${task.id}`)
  console.log(`REQUEST_ID=${requestId}`)
  const want = env('APPLICANT').toLowerCase()
  for (let i = 0; ; i++) {
    const { quotes } = await pub.quotes(requestId)
    const q = quotes.find((x) => x.worker.toLowerCase() === want)
    if (q !== undefined) {
      log(`picking ${q.amount} ${q.symbol} from agent ${q.agentId} (${q.note})`)
      const { taskId, publishTx } = await pub.pick(requestId, q.quoteId)
      log(`published the escrowed hire ${publishTx}; selected; task ${taskId}`)
      console.log(`TASK_ID=${taskId}`)
      break
    }
    if (i > 120) throw new Error('no quote from the applicant')
    await sleep(15)
  }
} else {
  const taskId = env('TASK_ID')
  const decision = env('DECISION') === 'accept'
    ? ({ accept: true } as const)
    : ({ accept: false, violation: env('VIOLATION', 'Quality') as 'None' | 'Quality' | 'Falsified', reason: env('REASON') } as const)
  for (const h of await pub.decide(taskId, decision)) log(`${decision.accept ? 'accept' : 'reject'} → https://testnet.monadscan.com/tx/${h}`)
  log(`chain status ${(await pub.board.call('get_task', { taskId })).chain.status}`)
}
