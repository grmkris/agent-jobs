/**
 * Testnet admin: register (or remove) an evidence verifier on every current stack's JobsEvaluator, so a host's key
 * can attach EvidenceAttested statements on-chain (ADR-0008, D10). Idempotent per stack. Run deliberately:
 *
 *   VERIFIER=0x… [ALLOWED=false] bun --env-file=.env.local packages/sdk/scripts/admin-set-verifier.ts
 */
import { type Hex, getAddress, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'
import { env, envLocal, log, txUrl } from './lib/common.ts'

const network = (process.env.AGENT_JOBS_NETWORK ?? 'monad-testnet') as sdk.Network
if (network !== 'monad-testnet') throw new Error('this script is testnet only')
const verifier = env('VERIFIER')
if (!isAddress(verifier)) throw new Error('VERIFIER must be a 0x address')
const allowed = (process.env.ALLOWED ?? 'true') !== 'false'
const rpc = envLocal('MONAD_TESTNET_RPC_URL').split(' ')[0] as string
const admin = sdk.wallet(network, privateKeyToAccount(envLocal('DEPLOYER_PRIVATE_KEY') as Hex), rpc)
const d = sdk.deployment(network)
if (admin.account.address.toLowerCase() !== d.admin.toLowerCase()) throw new Error(`DEPLOYER is ${admin.account.address}, the admin is ${d.admin}`)

for (const [name, stack] of sdk.allStacks(d)) {
  const ctx = sdk.contextFor(network, stack, rpc)
  const current = await ctx.publicClient.readContract({ address: stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'verifiers', args: [getAddress(verifier)] })
  if (current === allowed) {
    log('admin', `${name}: verifier ${verifier} already ${allowed ? 'registered' : 'absent'} on ${stack.evaluator}`)
    continue
  }
  const hash = await admin.writeContract({ address: stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'setVerifier', args: [getAddress(verifier), allowed] })
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${name}: setVerifier reverted: ${hash}`)
  log('admin', `${name}: setVerifier(${verifier}, ${allowed}) → ${txUrl(hash)}`)
}
