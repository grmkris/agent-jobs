import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi, parseEventLogs, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { monadTestnet } from 'viem/chains'
import { buildEvidence, canonicalJson, hashText, checkRunsUrl, encodeReport, evidenceDigest, requestSchema } from '../evidence.ts'

export const root = fileURLToPath(new URL('../../../', import.meta.url))
export const dir = resolve(root, 'workflows/ci-evidence')
export const local = resolve(dir, '.local')
export const configPath = resolve(root, 'contracts/config/monad-testnet.json')
export const config = JSON.parse(readFileSync(configPath, 'utf8'))
export const sim = config.cre.simulation as {
  forwarder: Address; evaluator: Address; holding: Address; gate: Address | null; receiver: Address | null;
  reportHash: Hex | null; rpcUrl: string; gasLimit: string; jobId: string
}
export const input = requestSchema.parse(JSON.parse(readFileSync(resolve(dir, 'payload.json'), 'utf8')))
export const rpc = createPublicClient({ chain: monadTestnet, transport: http(sim.rpcUrl, { retryCount: 0 }) })
export const abi = parseAbi([
  'function admin() view returns(address)', 'function verifiers(address) view returns(bool)',
  'function setVerifier(address,bool)', 'function receiver() view returns(address)',
  'function evaluator() view returns(address)', 'function forwarder() view returns(address)',
  'function reportHash() view returns(bytes32)', 'function policyHashOf(uint256) view returns(bytes32)',
  'function creatorOf(uint256) view returns(address)', 'function getForwarderAddress() view returns(address)',
  'function owner() view returns(address)',
  'function getExpectedAuthor() view returns(address)', 'function getExpectedWorkflowId() view returns(bytes32)',
  'function getExpectedWorkflowName() view returns(bytes10)',
  'function evidence(uint256,address) view returns(bytes32,bytes32,bytes32,bytes32,uint48,uint48,uint8)',
  'event EvidenceAttached(uint256 indexed jobId,address indexed verifier,bytes32 digest,bytes32 submissionHash,bytes32 policyHash,bytes32 testedSha,uint8 conclusion,uint256 validUntil)',
  'event ReportReceived(uint256 indexed jobId,bytes32 testedSha,uint8 conclusion)',
  'event JobSubmitted(uint256 indexed jobId,address indexed provider,bytes32 deliverable)',
])
export const jsonText = (x: unknown) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n'
export function save(path: string, value: unknown) { writeFileSync(path, jsonText(value), { mode: 0o600 }) }
export function deployerKey(): Hex {
  const path = resolve(root, '.env.local')
  const key = parseEnv(readFileSync(path, 'utf8')).DEPLOYER_PRIVATE_KEY
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('DEPLOYER_PRIVATE_KEY missing or malformed in .env.local')
  return key as Hex
}
export function loadKey() {
  const account = privateKeyToAccount(deployerKey())
  if (account.address.toLowerCase() !== config.roles.admin.toLowerCase()) throw new Error('deployer does not match configured testnet admin')
  return account
}
export async function preflight() {
  if (config.chainId !== 10143 || config.network !== 'monad-testnet' || await rpc.getChainId() !== 10143) throw new Error('testnet chain guard failed')
  mkdirSync(local, { recursive: true, mode: 0o700 })
  for (const address of [sim.forwarder, sim.evaluator, sim.holding]) {
    if ((await rpc.getCode({ address }) ?? '0x') === '0x') throw new Error(`missing contract bytecode: ${address}`)
  }
  const manifest = JSON.parse(readFileSync(resolve(root, 'docs/evidence/cre-simulation/job8-offer.json'), 'utf8'))
  if (hashText(canonicalJson(manifest)) !== input.policyHash || canonicalJson(manifest.evidencePolicy.checks) !== canonicalJson(input.requiredChecks)) throw new Error('request differs from the public accepted offer')
  if (manifest.deployment.evaluator.toLowerCase() !== sim.evaluator.toLowerCase() || manifest.deployment.holding.toLowerCase() !== sim.holding.toLowerCase()) throw new Error('fixture deployment mismatch')
  const snapshot = JSON.parse(readFileSync(resolve(root, 'docs/evidence/cre-simulation/job8-award-receipt.json'), 'utf8'))
  const historical = snapshot.data ?? snapshot
  const submissionReceipt = await rpc.getTransactionReceipt({ hash: historical.transactionHash })
  const submission = parseEventLogs({ abi, logs: submissionReceipt.logs }).find((e) => e.eventName === 'JobSubmitted' && e.args.jobId === BigInt(input.jobId) && e.address.toLowerCase() === config.deployment.core.toLowerCase())
  if (submissionReceipt.status !== 'success' || !submission || submission.eventName !== 'JobSubmitted' || submission.args.deliverable !== input.submissionHash) throw new Error('request differs from real JobSubmitted')
  const policy = await rpc.readContract({ address: sim.holding, abi, functionName: 'policyHashOf', args: [BigInt(input.jobId)] })
  if (policy !== input.policyHash) throw new Error('request policy differs from real listing')
  const response = await fetch(checkRunsUrl(input), { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-jobs-cre-preflight' } })
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
  const body = await response.json()
  const built = buildEvidence(input, body, Math.floor(Date.now() / 1000))
  const report = encodeReport(built.attestation)
  const reportHash = keccak256(report)
  const digest = evidenceDigest(built.attestation, config.chainId, sim.evaluator)
  save(resolve(local, 'preflight.json'), { input, body, ...built, report, reportHash, digest, at: new Date().toISOString() })
  return { ...built, report, reportHash, digest }
}

/** Persist transaction hash BEFORE submitting, then reconcile the exact receipt on rerun. No blind retry. */
export async function sendOnce(id: string, data: Hex, to?: Address) {
  const account = loadKey()
  const journal = resolve(local, `${id}.json`)
  if (existsSync(journal)) {
    const old = JSON.parse(readFileSync(journal, 'utf8'))
    if (old.dataHash !== keccak256(data) || old.to !== (to ?? null)) throw new Error(`operation ${id} changed; inspect its journal`)
    if (!old.txHash) throw new Error(`operation ${id} interrupted before submit; reconcile nonce ${old.nonce} before any retry`)
    const receipt = await rpc.getTransactionReceipt({ hash: old.txHash })
    if (receipt.status !== 'success') throw new Error(`operation ${id} reverted; no automatic retry`)
    return receipt
  }
  const nonce = await rpc.getTransactionCount({ address: account.address, blockTag: 'pending' })
  if (nonce !== await rpc.getTransactionCount({ address: account.address, blockTag: 'latest' })) throw new Error('shared deployer has a pending transaction; retry after it confirms')
  const gas = await rpc.estimateGas({ account, data, ...(to ? { to } : {}) }) * 12n / 10n
  const gasPrice = await rpc.getGasPrice()
  if (gas * gasPrice > 300_000_000_000_000_000n) throw new Error('operation exceeds 0.3 testnet MON gas cap')
  if (await rpc.getBalance({ address: account.address }) < gas * gasPrice + 30_000_000_000_000_000n) throw new Error('insufficient testnet gas plus cleanup reserve')
  const intent = { id, chainId: 10143, sender: account.address, nonce, to: to ?? null, dataHash: keccak256(data), gas, gasPrice, at: new Date().toISOString() }
  save(journal, intent)
  const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(sim.rpcUrl, { retryCount: 0 }) })
  const serialized = await wallet.signTransaction({ data, ...(to ? { to } : {}), nonce, gas, gasPrice, type: 'legacy' })
  const txHash = keccak256(serialized)
  save(journal, { ...intent, txHash })
  await rpc.sendRawTransaction({ serializedTransaction: serialized })
  const receipt = await rpc.waitForTransactionReceipt({ hash: txHash })
  save(journal, { ...intent, txHash, receipt })
  if (receipt.status !== 'success') throw new Error(`${id} reverted: ${txHash}`)
  console.log(`${id}: ${txHash}`)
  return receipt
}
export async function verifyDeployment() {
  if (!sim.gate || !sim.receiver || !sim.reportHash) throw new Error('simulation deployment missing')
  const [forwarder, receiver, reportHash, evaluator, owner, receiverForwarder, author, workflowId, name] = await Promise.all([
    rpc.readContract({ address: sim.gate, abi, functionName: 'forwarder' }),
    rpc.readContract({ address: sim.gate, abi, functionName: 'receiver' }),
    rpc.readContract({ address: sim.gate, abi, functionName: 'reportHash' }),
    rpc.readContract({ address: sim.receiver, abi, functionName: 'evaluator' }),
    rpc.readContract({ address: sim.receiver, abi, functionName: 'owner' }),
    rpc.readContract({ address: sim.receiver, abi, functionName: 'getForwarderAddress' }),
    rpc.readContract({ address: sim.receiver, abi, functionName: 'getExpectedAuthor' }),
    rpc.readContract({ address: sim.receiver, abi, functionName: 'getExpectedWorkflowId' }),
    rpc.readContract({ address: sim.receiver, abi, functionName: 'getExpectedWorkflowName' }),
  ])
  if (forwarder.toLowerCase() !== sim.forwarder.toLowerCase() || receiver.toLowerCase() !== sim.receiver.toLowerCase() || reportHash !== sim.reportHash || evaluator.toLowerCase() !== sim.evaluator.toLowerCase() || owner.toLowerCase() !== sim.gate.toLowerCase() || receiverForwarder.toLowerCase() !== sim.gate.toLowerCase() || ![author, workflowId, name].every((v) => /^0x0+$/.test(v))) throw new Error('simulation deployment permission mismatch')
}

export async function registration(allowed: boolean, operation: string) {
  if (!sim.receiver) throw new Error('run cre:setup first')
  const current = await rpc.readContract({ address: sim.evaluator, abi, functionName: 'verifiers', args: [sim.receiver] })
  if (current === allowed) return
  const receipt = await sendOnce(operation, encodeFunctionData({ abi, functionName: 'setVerifier', args: [sim.receiver, allowed] }), sim.evaluator)
  const after = await rpc.readContract({ address: sim.evaluator, abi, functionName: 'verifiers', args: [sim.receiver] })
  if (after !== allowed) throw new Error('verifier registration did not reach expected state')
  return receipt
}
export function fail(error: unknown) {
  // viem errors can include call details. Never print environment values or raw signed transactions.
  const message = error instanceof Error ? error.message.split('\n')[0]! : 'unknown failure'
  const key = process.env.DEPLOYER_PRIVATE_KEY
  console.error(key ? message.replaceAll(key, '[redacted]') : message)
  process.exitCode = 1
}
