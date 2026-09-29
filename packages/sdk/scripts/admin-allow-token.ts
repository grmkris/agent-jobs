/**
 * Testnet admin: allowlist one more ERC-20 as a reward token on the core and record it in the network config, so
 * boards may pay in it (ADR-0008, D7). Idempotent. Run deliberately, never as a cached task:
 *
 *   TOKEN=0x1305… bun --env-file=.env.local packages/sdk/scripts/admin-allow-token.ts
 *
 * The admin of the core is the deployer EOA (contracts/config/<network>.json roles.admin); mainnet is refused.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { type Address, type Hex, getAddress, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'
import { env, envLocal, log, txUrl } from './lib/common.ts'

const network = (process.env.AGENT_JOBS_NETWORK ?? 'monad-testnet') as sdk.Network
if (network !== 'monad-testnet') throw new Error('allowlisting through this script is testnet only')
const token = env('TOKEN')
if (!isAddress(token)) throw new Error('TOKEN must be a 0x address')
const rpc = envLocal('MONAD_TESTNET_RPC_URL').split(' ')[0] as string
const ctx = sdk.context(network, 'main', rpc)
const admin = sdk.wallet(network, privateKeyToAccount(envLocal('DEPLOYER_PRIVATE_KEY') as Hex), rpc)
if (admin.account.address.toLowerCase() !== ctx.deployment.admin.toLowerCase()) throw new Error(`DEPLOYER is ${admin.account.address}, the admin is ${ctx.deployment.admin}`)

const address = getAddress(token) as Address
const [symbol, decimals] = await Promise.all([
  ctx.publicClient.readContract({ address, abi: sdk.factoryTokenAbi, functionName: 'symbol' }),
  ctx.publicClient.readContract({ address, abi: sdk.factoryTokenAbi, functionName: 'decimals' }),
])
log('admin', `${symbol} (${decimals} decimals) at ${address}`)
const allowed = await ctx.publicClient.readContract({ address: ctx.deployment.core, abi: sdk.coreAbi, functionName: 'allowedPaymentTokens', args: [address] })
if (allowed) log('admin', 'already allowed on the core')
else {
  const hash = await admin.writeContract({ address: ctx.deployment.core, abi: sdk.coreAbi, functionName: 'setPaymentTokenAllowed', args: [address, true] })
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`setPaymentTokenAllowed reverted: ${hash}`)
  log('admin', `setPaymentTokenAllowed(${symbol}, true) → ${txUrl(hash)}`)
}

const path = new URL(`../../../contracts/config/${network}.json`, import.meta.url)
const config = JSON.parse(readFileSync(path, 'utf8')) as { allowedTokens: string[]; deployment: { rewardTokens: string[] } }
const has = (list: string[]) => list.some((a) => a.toLowerCase() === address.toLowerCase())
if (!has(config.allowedTokens)) config.allowedTokens.push(address)
if (!has(config.deployment.rewardTokens)) config.deployment.rewardTokens.push(address)
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
log('admin', `config ${path.pathname}: rewardTokens now ${config.deployment.rewardTokens.length}, allowedTokens ${config.allowedTokens.length}`)
