/**
 * Readies a testnet worker wallet for the bounty campaign: FACTORY from the testnet faucet (for worker bonds) and an
 * ERC-8004 agent registered to the wallet on the real Identity Registry. Idempotent; prints the agent id.
 *
 *   KEY_VAR=CAMPAIGN_CLAUDE_PRIVATE_KEY bun packages/sdk/scripts/campaign-wallet.ts   (from the repo root)
 */
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'

const keyVar = process.env.KEY_VAR ?? ''
const key = process.env[keyVar]
if (key === undefined || key === '') throw new Error(`set KEY_VAR to a .env.local key variable (got "${keyVar}")`)
const rpc = process.env.MONAD_TESTNET_RPC_URL ?? ''
const ctx = sdk.context('monad-testnet', 'main', rpc)
const w = sdk.wallet('monad-testnet', privateKeyToAccount(key as Hex), rpc)
const who = w.account.address

if ((await sdk.balanceOf(ctx, ctx.deployment.factory, who)) < 10n * 10n ** 18n) {
  const r = await sdk.faucet(ctx, w, ctx.deployment.factory)
  console.log(`${keyVar}: faucet FACTORY ${r.transactionHash}`)
}
const known = process.env[keyVar.replace(/_PRIVATE_KEY$/, '_AGENT_ID')]
let agentId = known === undefined || known === '' ? undefined : BigInt(known)
if (agentId === undefined || (await sdk.agentWallet(ctx, agentId)) !== who) {
  agentId = await sdk.registerAgent(ctx, w, `https://github.com/grmkris/agent-jobs#campaign-${keyVar.toLowerCase()}`)
}
console.log(`${keyVar}: wallet ${who}, agent ${agentId}`)
