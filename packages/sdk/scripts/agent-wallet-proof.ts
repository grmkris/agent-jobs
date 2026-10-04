/** Deliberate, sign-only provider proof. This is never a cached task and never broadcasts.
 * The fixture owner is a P-256 key, not a human Privy user. Passing this script cannot
 * enable production capability or establish browser-owned policy consent.
 */
import { generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { encodeFunctionData, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, type Hex, type TransactionSerialized } from 'viem'
import { signPrivyAuthorization } from '../src/companion-protocol.ts'

const local = parseEnv(readFileSync(new URL('../../../.env.local', import.meta.url), 'utf8'))
const appId = local.PRIVY_APP_ID, appSecret = local.PRIVY_APP_SECRET
if (!appId || !appSecret) throw new Error('Hireling Privy credentials are unavailable')
const api = 'https://api.privy.io/v1'
const config = JSON.parse(readFileSync(new URL('../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8')) as { deployment: { core: Hex; main: { evaluator: Hex } } }
const submitAbi = parseAbi(['function submit(uint256 jobId, bytes32 deliverable, bytes optParams)'])
const submitData = encodeFunctionData({ abi: submitAbi, functionName: 'submit', args: [1n, `0x${'11'.repeat(32)}`, '0x'] })
const owner = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const worker = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const publicKey = (key: KeyObject) => key.export({ format: 'der', type: 'spki' }).toString('base64')
const runId = randomUUID()
type ProviderReply = { status: number; body: Record<string, unknown> }
type Check = { check: string; pass: boolean; status?: number; code?: string }
const checks: Check[] = []

async function request(path: string, method: string, body: unknown, key?: KeyObject, options: { expiry?: string; signatureBody?: unknown; signatureUrl?: string; mutateExpiry?: string } = {}): Promise<ProviderReply> {
  const url = `${api}${path}`, expiry = options.expiry ?? String(Date.now() + 60_000)
  const headers: Record<string, string> = { 'privy-app-id': appId!, 'privy-request-expiry': expiry }
  if (key !== undefined) headers['privy-authorization-signature'] = signPrivyAuthorization(key, { method, url: options.signatureUrl ?? url, headers, body: JSON.stringify(options.signatureBody ?? body), expiresAt: expiry })
  if (options.mutateExpiry !== undefined) headers['privy-request-expiry'] = options.mutateExpiry
  const res = await fetch(url, { method, headers: { ...headers, authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(25_000) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}
function record(check: string, reply: ProviderReply, expected: 'accept' | 'deny', code?: string): void {
  const providerCode = typeof reply.body.code === 'string' ? reply.body.code : typeof reply.body.error === 'string' ? reply.body.error : undefined
  const actualCode = providerCode !== undefined && /^[a-z0-9_]{1,80}$/.test(providerCode) ? providerCode : undefined
  const pass = expected === 'accept' ? reply.status >= 200 && reply.status < 300 : reply.status >= 400 && reply.status < 500 && (code === undefined || actualCode === code)
  checks.push({ check, pass, status: reply.status, ...(actualCode === undefined ? {} : { code: actualCode }) })
  if (!pass) throw new Error(`Provider control proof failed: ${check} (HTTP ${reply.status})`)
}
function identity(reply: ProviderReply, field: string): string {
  const value = reply.body[field]
  if (typeof value !== 'string') throw new Error(`Provider omitted ${field}`)
  return value
}
const until = Math.floor(Date.now() / 1000) + 600
const condition = (source: string, field: string, value: string | number, extra = {}) => ({ field_source: source, field, operator: 'eq', value, ...extra })
const policyBody = {
  version: '1.0', name: `Hireling submit proof ${runId.slice(0, 8)}`, chain_type: 'ethereum', owner: { public_key: publicKey(owner.publicKey) },
  rules: [{ name: 'Job 1 submit only', method: 'eth_signTransaction', action: 'ALLOW', conditions: [
    condition('ethereum_transaction', 'to', config.deployment.core), condition('ethereum_transaction', 'chain_id', '10143'), condition('ethereum_transaction', 'value', '0'),
    condition('ethereum_calldata', 'function_name', 'submit', { abi: submitAbi }), condition('ethereum_calldata', 'submit.jobId', '1', { abi: submitAbi }),
    { field_source: 'system', field: 'current_unix_timestamp', operator: 'lt', value: String(until) },
  ] }],
}
let walletId: string | undefined, walletAddress: string | undefined, policyId: string | undefined
let revoked = false
try {
  const quorum = await request('/key_quorums', 'POST', { display_name: `Hireling local K ${runId.slice(0, 8)}`, public_keys: [publicKey(worker.publicKey)], authorization_threshold: 1 })
  record('runtime-key-quorum', quorum, 'accept'); const signerId = identity(quorum, 'id')
  const policy = await request('/policies', 'POST', policyBody)
  record('owned-composite-policy', policy, 'accept'); policyId = identity(policy, 'id')
  const wallet = await request('/wallets', 'POST', { chain_type: 'ethereum', owner: { public_key: publicKey(owner.publicKey) }, additional_signers: [{ signer_id: signerId, override_policy_ids: [policyId] }] })
  record('owned-wallet-restricted-signer', wallet, 'accept'); walletId = identity(wallet, 'id'); walletAddress = identity(wallet, 'address')
  const transaction = { to: config.deployment.core, chain_id: 10143, data: submitData, value: '0x0', nonce: '0x0', type: 2, gas_limit: '0xf4240', max_fee_per_gas: '0x3b9aca00', max_priority_fee_per_gas: '0x0' }
  const rpcBody = (tx: Record<string, unknown>) => ({ method: 'eth_signTransaction', params: { transaction: tx } })
  const rpcPath = `/wallets/${walletId}/rpc`
  const approved = await request(rpcPath, 'POST', rpcBody(transaction), worker.privateKey)
  record('direct-job-scoped-submit-sign-only', approved, 'accept')
  const data = approved.body.data as { signed_transaction?: Hex }
  if (!data?.signed_transaction) throw new Error('Provider did not return raw signed bytes')
  const parsed = parseTransaction(data.signed_transaction)
  const recovered = await recoverTransactionAddress({ serializedTransaction: data.signed_transaction as TransactionSerialized })
  const exact = parsed.type === 'eip1559' && recovered.toLowerCase() === walletAddress.toLowerCase() && parsed.chainId === 10143 && parsed.to?.toLowerCase() === config.deployment.core.toLowerCase() && parsed.data === submitData && (parsed.value ?? 0n) === 0n && parsed.nonce === 0
  checks.push({ check: 'raw-rlp-recovered-exact-wallet-and-call', pass: exact })
  if (!exact) throw new Error(`Signed transaction changed its frozen intent (recovered=${recovered}, chain=${parsed.chainId}, to=${parsed.to}, data=${parsed.data === submitData}, value=${parsed.value}, nonce=${parsed.nonce})`)
  const signatureHash = keccak256(data.signed_transaction)
  for (const [label, changed] of [
    ['wrong-job', { data: encodeFunctionData({ abi: submitAbi, functionName: 'submit', args: [2n, `0x${'11'.repeat(32)}`, '0x'] }) }],
    ['wrong-target', { to: config.deployment.main.evaluator }], ['wrong-chain', { chain_id: 1 }], ['nonzero-value', { value: '0x1' }], ['wrong-function', { data: '0x095ea7b3' + '00'.repeat(64) }],
  ] as const) record(label, await request(rpcPath, 'POST', rpcBody({ ...transaction, ...changed }), worker.privateKey), 'deny', 'policy_violation')
  record('app-secret-only-signing', await request(rpcPath, 'POST', rpcBody(transaction)), 'deny')
  record('altered-body-authorization', await request(rpcPath, 'POST', rpcBody({ ...transaction, nonce: '0x1' }), worker.privateKey, { signatureBody: rpcBody(transaction) }), 'deny')
  record('altered-url-authorization', await request(rpcPath, 'POST', rpcBody(transaction), worker.privateKey, { signatureUrl: `${api}/wallets/different/rpc` }), 'deny')
  record('altered-expiry-authorization', await request(rpcPath, 'POST', rpcBody(transaction), worker.privateKey, { mutateExpiry: String(Date.now() + 120_000) }), 'deny')
  record('expired-authorization', await request(rpcPath, 'POST', rpcBody(transaction), worker.privateKey, { expiry: String(Date.now() - 60_000) }), 'deny')
  record('runtime-cannot-change-policy', await request(`/policies/${policyId}`, 'PATCH', { rules: [] }, worker.privateKey), 'deny')
  record('app-secret-cannot-change-owned-policy', await request(`/policies/${policyId}`, 'PATCH', { rules: [] }), 'deny')
  record('fixture-owner-can-update-policy', await request(`/policies/${policyId}`, 'PATCH', { name: 'Hireling owner PATCH proof' }, owner.privateKey), 'accept')
  record('fixture-owner-revokes-signer', await request(`/wallets/${walletId}`, 'PATCH', { additional_signers: [] }, owner.privateKey), 'accept'); revoked = true
  record('revoked-runtime-cannot-sign', await request(rpcPath, 'POST', rpcBody(transaction), worker.privateKey), 'deny')
  console.log(JSON.stringify({ evidence: 'real-provider-sign-only-key-owned-fixture', runId, at: new Date().toISOString(), walletAddress, signedTransactionHash: signatureHash, broadcast: false, browserOwnerConsentProven: false, automaticCapabilityEnabled: false, checks }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ evidence: 'real-provider-sign-only-key-owned-fixture', runId, broadcast: false, automaticCapabilityEnabled: false, checks, error: error instanceof Error && (error.message.startsWith('Provider') || error.message.startsWith('Signed transaction')) ? error.message : 'Proof did not complete; no capability enabled' }))
  process.exitCode = 1
} finally {
  if (walletId !== undefined && !revoked) {
    const reply = await request(`/wallets/${walletId}`, 'PATCH', { additional_signers: [] }, owner.privateKey).catch(() => undefined)
    if (reply === undefined || reply.status >= 300) { console.error('Fixture signer cleanup was not verified; its policy expires within ten minutes.'); process.exitCode = 1 }
  }
}
