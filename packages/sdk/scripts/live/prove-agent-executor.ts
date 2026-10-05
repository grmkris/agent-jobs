/** P3: the product executor, real Privy fixture signing and one harmless testnet relay call. */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { type Address, type Hex, encodeFunctionData, keccak256, parseEther, stringToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../../src/index.ts'
import { AgentExecutor } from '../../../board/src/agent-executor.ts'
import { AgentStore, canonicalAgentArgs } from '../../../board/src/agents.ts'
import { AgentSigning } from '../../../board/src/agent-signing.ts'
import { SponsorDesk } from '../../../board/src/sponsor.ts'
import { fromNodeSqlite } from '../../../board/src/store.ts'
import { localEnv, required } from '../privy/env.ts'
import { spentAndReserved } from './authority-cost.ts'

const evidencePath = new URL('../../../../docs/evidence/agent-first-v2/p3-executor.json', import.meta.url)
const directory = new URL('./.local/', import.meta.url)
let stage = 'initialization'
const currentUnixSeconds = () => Math.floor(Date.now() / 1000)

async function prove(): Promise<void> {
  const env = localEnv()
  const prior = JSON.parse(readFileSync(new URL('../../../../docs/evidence/agent-first-v2/p0-authority.json', import.meta.url), 'utf8')) as {
    fixture: { runId: string; userId: string; walletId: string; address: Address }
    results: Array<{ proof: number; status: string; details: Array<{ agentId?: string; owner?: Address }> }>
  }
  const registered = prior.results.find(result => result.proof === 4 && result.status === 'pass')?.details.find(detail => detail.agentId !== undefined)
  if (registered?.agentId === undefined || registered.owner === undefined) throw new Error('P0 registration fixture is unavailable')
  const ctx = sdk.context('monad-testnet', 'main', required(env, 'MONAD_TESTNET_RPC_URL'))
  if (await ctx.publicClient.getChainId() !== 10143) throw new Error('Only testnet is authorized')
  const relay = privateKeyToAccount(required(env, 'RELAY_PRIVATE_KEY') as Hex)
  if (relay.address.toLowerCase() !== ctx.deployment.relay.toLowerCase()) throw new Error('Relay binding mismatch')
  stage = 'fixture-budget'
  const chainJournal = sdk.parseFlowJson(readFileSync(new URL('chain.json', directory), 'utf8'))
  const fees = await sdk.transactionFees(ctx.publicClient)
  const fixtureGasCap = 1_000_000n
  const fixtureCostCap = parseEther('0.25')
  const priorCost = spentAndReserved(chainJournal)
  if (priorCost + fixtureGasCap * fees.maxFeePerGas >= parseEther('1')) throw new Error('Fixture run budget would exceed 1 MON')
  if (fixtureGasCap * fees.maxFeePerGas > fixtureCostCap) throw new Error('One-call fixture budget exceeds 0.25 MON')
  const signTransaction = relay.signTransaction
  relay.signTransaction = async parameters => {
    if (parameters.gas === undefined || parameters.gas > fixtureGasCap || parameters.maxFeePerGas === undefined
      || parameters.gas * parameters.maxFeePerGas > fixtureCostCap
      || priorCost + parameters.gas * parameters.maxFeePerGas >= parseEther('1')) throw new Error('Actual fixture transaction exceeds its budget')
    return signTransaction(parameters)
  }
  stage = 'registry-binding'
  const [owner, wallet, code] = await Promise.all([
    ctx.publicClient.readContract({ address: ctx.deployment.identity, abi: sdk.identityAbi, functionName: 'ownerOf', args: [BigInt(registered.agentId)] }),
    sdk.agentWallet(ctx, BigInt(registered.agentId)),
    sdk.delegationOf(ctx.publicClient, prior.fixture.address),
  ])
  if (owner.toLowerCase() !== registered.owner.toLowerCase() || wallet.toLowerCase() !== prior.fixture.address.toLowerCase()
    || code?.toLowerCase() !== ctx.deployment.delegation.delegator.toLowerCase()) throw new Error('Fixture registry or upgrade binding changed')
  const provider = new sdk.PrivyServer({ appId: required(env, 'PRIVY_APP_ID'), appSecret: required(env, 'PRIVY_APP_SECRET'), sign: await sdk.p256AuthorizationSigner(required(env, 'PRIVY_SIGNER_KEY')) })
  stage = 'Privy-wallet-authority'
  await provider.verifyAgentWallet(prior.fixture.walletId, prior.fixture.userId, required(env, 'PRIVY_SIGNER_ID'), required(env, 'PRIVY_POLICY_ID'))
  stage = 'fixture-storage'
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const dbPath = new URL('p3-executor.sqlite', directory)
  const db = new DatabaseSync(dbPath.pathname)
  chmodSync(dbPath, 0o600)
  try {
    const sql = fromNodeSqlite(db)
    const now = currentUnixSeconds
    const agents = new AgentStore(sql, now)
    const id = `p3-${prior.fixture.runId}`
    agents.create({ id, operator: owner, privyUserId: prior.fixture.userId, name: 'P3 live fixture', registry: ctx.deployment.identity, chainId: ctx.deployment.chainId })
    agents.bindWallet(id, prior.fixture.walletId, wallet)
    agents.bindRegistry(id, registered.agentId)
    for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const) {
      const order = ['created', 'upgraded', 'grants-live', 'registered', 'active']
      if (order.indexOf(agents.get(id).state) >= order.indexOf(state)) continue
      agents.advance(id, state)
    }
    const signing = new AgentSigning(sql, ctx, provider, now)
    const boot = () => new AgentExecutor({ sql, context: ctx, now, signing,
      sponsor: new SponsorDesk({ sql, ctx, now, relay: { account: relay, rpcUrl: required(env, 'MONAD_TESTNET_RPC_URL') }, fail: (_code, message) => new Error(message) }),
      prepareTool: async () => ({ transactions: [{ description: 'Cancel one unused fixture Selection nonce', chainId: 10143, to: ctx.stack.holding, value: '0',
        data: encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'cancelSelection', args: [BigInt(keccak256(stringToHex(`p3:${id}`)))] }) }] }),
      verifyToolSigning: async () => { throw new Error('This fixture requests grant signatures only') },
    })
    const input = { agentId: id, boardId: 'p3-live-fixture', operationKey: 'p3-live-executor', tool: 'fixture_cancel_selection', args: {} }
    stage = 'executor'
    const result = await boot().execute(input)
    if (result.status !== 'confirmed') throw new Error('Fixture operation is not confirmed')
    const output = result.result as { sponsorship: { txHash: Hex } }
    const receipt = await ctx.publicClient.getTransactionReceipt({ hash: output.sponsorship.txHash })
    const requests = sql.all<{ total: number }>('SELECT count(*) total FROM agent_sign_requests')[0]!.total
    const nonce = await ctx.publicClient.getTransactionCount({ address: relay.address })
    stage = 'reconstruction'
    const repeated = await boot().execute(input)
    if (canonicalAgentArgs(repeated) !== canonicalAgentArgs(result) || await ctx.publicClient.getTransactionCount({ address: relay.address }) !== nonce
      || sql.all<{ total: number }>('SELECT count(*) total FROM agent_sign_requests')[0]!.total !== requests) throw new Error('Retry changed the original operation or signatures')
    const evidence = { recordedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sourceStatus: 'P3 executor source under verification', network: 'monad-testnet', chainId: 10143, identity: 'API-created P0 fixture; no genuine-user consent',
      proof: 'product executor and signing journal with live Privy and testnet relay; hosted HTTP acceptance remains P8',
      status: 'pass', agent: wallet, registryAgentId: registered.agentId, txHash: receipt.transactionHash,
      gasUsed: receipt.gasUsed.toString(), costWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), signerRequests: requests,
      retriesReuseSignedSend: true, retriesDoNotSign: true, fixtureRunBudgetWei: parseEther('1').toString() }
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(JSON.stringify(evidence))
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  try { await prove() }
  catch { console.error(`P3 live fixture refused at ${stage}; provider and request details suppressed`); process.exitCode = 1 }
}
