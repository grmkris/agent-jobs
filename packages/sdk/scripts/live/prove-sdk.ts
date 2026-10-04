/** P2 integration proof: the production SDK signs with the retained P0 Privy fixture, never sends a transaction. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { type Address, recoverTypedDataAddress } from 'viem'
import { context } from '../../src/client.ts'
import { PrivyServer, PrivyServerError } from '../../src/privy-server.ts'
import { p256AuthorizationSigner } from '../../src/p256.ts'
import { assertGrant, buildGrant, describeGrant } from '../../src/delegation/grants.ts'
import { delegationHash, delegationTypedData } from '../../src/delegation/index.ts'
import { localEnv, required } from '../privy/env.ts'

const privatePath = new URL('./.local/sdk-proof.json', import.meta.url)
const fixturePath = new URL('./.local/authority.json', import.meta.url)
const evidencePath = new URL('../../../../docs/evidence/agent-first-v2/p2-sdk.json', import.meta.url)

async function prove(): Promise<void> {
  const env = localEnv()
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { runId: string; userId: string; walletId: string; address: Address }
  const ctx = context('monad-testnet', 'main', required(env, 'MONAD_TESTNET_RPC_URL'))
  if (await ctx.publicClient.getChainId() !== 10143) throw new Error('P2 proof requires testnet 10143')
  const api = new PrivyServer({ appId: required(env, 'PRIVY_APP_ID'), appSecret: required(env, 'PRIVY_APP_SECRET'), sign: await p256AuthorizationSigner(required(env, 'PRIVY_SIGNER_KEY')) })
  const wallet = await api.verifyAgentWallet(fixture.walletId, fixture.userId, required(env, 'PRIVY_SIGNER_ID'), required(env, 'PRIVY_POLICY_ID'))
  if (wallet.address.toLowerCase() !== fixture.address.toLowerCase()) throw new Error('P2 fixture wallet mismatch')
  const record = existsSync(privatePath) ? JSON.parse(readFileSync(privatePath, 'utf8')) as { start: number; typedData: string; key: string; signature?: `0x${string}` }
    : { start: Number((await ctx.publicClient.getBlock()).timestamp), typedData: '', key: crypto.randomUUID() }
  const spec = { kind: 'agent-work' as const, delegator: fixture.address, salt: 1002n, start: record.start }
  const grant = buildGrant(ctx, spec)
  assertGrant(ctx, spec, grant)
  const typedData = delegationTypedData(ctx.deployment, grant)
  if (record.typedData && record.typedData !== typedData) throw new Error('P2 prepared bytes changed')
  record.typedData = typedData
  writeFileSync(privatePath, JSON.stringify(record), { mode: 0o600 })
  record.signature ??= await api.signTypedData(fixture.walletId, typedData, record.key)
  writeFileSync(privatePath, JSON.stringify(record), { mode: 0o600 })
  const recovered = await recoverTypedDataAddress({ ...JSON.parse(typedData), signature: record.signature })
  if (recovered.toLowerCase() !== fixture.address.toLowerCase()) throw new Error('P2 signature recovery mismatch')
  const sourceFiles = ['packages/sdk/src/privy-server.ts', 'packages/sdk/src/p256.ts', 'packages/sdk/src/delegation/grants.ts', 'packages/sdk/src/registry.ts']
  const evidence = {
    status: 'pass', fixture: true, network: 'monad-testnet', chainId: 10143,
    observedAt: new Date().toISOString(), baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])),
    wallet: fixture.address, walletAuthorityVerified: true, productionSdkRpcSignatureRecovered: recovered,
    grantHash: delegationHash(grant), grant: describeGrant(ctx, spec, grant),
    transactions: [], note: 'Retained API-created P0 fixture; genuine browser ownership and recovery remain P8 acceptance gates.',
  }
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log('P2 PASS: production SDK verified fixture ownership and recovered the scoped RPC signature; no transaction sent')
}

prove().catch(error => {
  console.error(error instanceof PrivyServerError ? error.message : 'P2 proof failed; provider and request details suppressed')
  process.exitCode = 1
})
