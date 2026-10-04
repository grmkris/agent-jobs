/** Narrow sign-only worker wallet path. The gateway owns application credentials;
 * the caller's P-256 signer authorizes an exact Privy request as the stable wallet.
 */
import { type Address, type Hex, type TransactionReceipt, type TransactionSerialized, createPublicClient, decodeFunctionData, http, keccak256, parseTransaction, recoverTransactionAddress } from 'viem'
import { monadTestnet } from 'viem/chains'
import { coreAbi, hirelingEvaluatorAbi } from './abi/index.ts'
import { formatPrivyAuthorizationPayload } from './privy.ts'

export interface WorkerTransaction {
  chainId: 10143; to: Address; data: Hex; value: '0'; nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint
}
export interface WorkerGrant { operationId: string; kind: 'submit' | 'dispute'; jobId: bigint; wallet: Address; target: Address; transaction: WorkerTransaction }
export interface SignedWorkerOperation { operationId: string; kind: 'submit' | 'dispute'; jobId: string; wallet: Address; raw: Hex; hash: Hex; nonce: number }
export interface WorkerJournal { sends: Record<string, SignedWorkerOperation>; receipts: Record<string, { status: string; blockNumber: string; transactionHash: Hex }> }
export interface WorkerGatewayConfig { apiOrigin: string; managedId: string; runtimeToken: string; appId: string; walletId: string; signAuthorization(payload: string): Promise<string> }

export function assertWorkerTransaction(grant: WorkerGrant): void {
  const tx = grant.transaction
  if (tx.chainId !== 10143 || tx.value !== '0' || tx.to.toLowerCase() !== grant.target.toLowerCase()) throw new Error('worker wallet target/value/chain mismatch')
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0 || tx.gas <= 0n || tx.maxFeePerGas < tx.maxPriorityFeePerGas || tx.maxPriorityFeePerGas < 0n) throw new Error('invalid worker transaction fee or nonce')
  const decoded = grant.kind === 'submit' ? decodeFunctionData({ abi: coreAbi, data: tx.data }) : decodeFunctionData({ abi: hirelingEvaluatorAbi, data: tx.data })
  if (decoded.functionName !== grant.kind || decoded.args?.[0] !== grant.jobId) throw new Error('worker grant/job/function mismatch')
  if (grant.kind === 'submit' && (decoded.args?.[2] ?? '0x') !== '0x') throw new Error('worker submit cannot include a hook')
}

export function workerPrivyTransaction(tx: WorkerTransaction): Record<string, unknown> {
  return { type: 2, chain_id: tx.chainId, to: tx.to, data: tx.data, value: '0x0', nonce: tx.nonce, gas_limit: `0x${tx.gas.toString(16)}`, max_fee_per_gas: `0x${tx.maxFeePerGas.toString(16)}`, max_priority_fee_per_gas: `0x${tx.maxPriorityFeePerGas.toString(16)}` }
}

export async function validateSignedWorkerTransaction(raw: Hex, grant: WorkerGrant): Promise<SignedWorkerOperation> {
  assertWorkerTransaction(grant)
  const parsed = parseTransaction(raw), tx = grant.transaction
  if (parsed.type !== 'eip1559' || parsed.chainId !== 10143 || parsed.to?.toLowerCase() !== tx.to.toLowerCase() || (parsed.value ?? 0n) !== 0n || parsed.data !== tx.data || parsed.nonce !== tx.nonce || parsed.gas !== tx.gas || parsed.maxFeePerGas !== tx.maxFeePerGas || parsed.maxPriorityFeePerGas !== tx.maxPriorityFeePerGas || (parsed.accessList?.length ?? 0) !== 0) throw new Error('signed worker transaction differs from prepared operation')
  const wallet = await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized })
  if (wallet.toLowerCase() !== grant.wallet.toLowerCase()) throw new Error('Privy signed for another wallet')
  return { operationId: grant.operationId, kind: grant.kind, jobId: grant.jobId.toString(), wallet, raw, hash: keccak256(raw), nonce: tx.nonce }
}

export async function signWorkerTransaction(cfg: WorkerGatewayConfig, grant: WorkerGrant): Promise<SignedWorkerOperation> {
  assertWorkerTransaction(grant)
  const url = `https://api.privy.io/v1/wallets/${encodeURIComponent(cfg.walletId)}/rpc`
  const body = { method: 'eth_signTransaction', params: { transaction: workerPrivyTransaction(grant.transaction) } }
  const headers = { 'privy-app-id': cfg.appId, 'privy-idempotency-key': grant.operationId, 'privy-request-expiry': String(Date.now() + 60_000) }
  const authorizationSignature = await cfg.signAuthorization(formatPrivyAuthorizationPayload({ method: 'POST', url, body, headers }))
  const response = await fetch(new URL(`/api/agents/${encodeURIComponent(cfg.managedId)}/wallet/rpc`, cfg.apiOrigin), { method: 'POST', headers: { authorization: `Bearer ${cfg.runtimeToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ operationId: grant.operationId, kind: grant.kind, jobId: grant.jobId.toString(), request: { method: 'POST', url, headers, body }, authorizationSignature }) })
  const json = await response.json() as { ok?: boolean; result?: { data?: { signed_transaction?: Hex }; rawTransaction?: Hex }; message?: string; data?: { signed_transaction?: Hex } }
  if (!response.ok || json.ok === false) throw new Error(`worker signing refused: ${json.message ?? response.status}`)
  const raw = json.result?.rawTransaction ?? json.result?.data?.signed_transaction ?? json.data?.signed_transaction
  if (raw === undefined) throw new Error('worker sign-only gateway returned no transaction')
  return validateSignedWorkerTransaction(raw, grant)
}

/** One pending wallet send at a time; a stored raw transaction is replayed as-is. */
export class WorkerOperationJournal {
  #queue: Promise<unknown> = Promise.resolve()
  readonly client
  constructor(readonly state: WorkerJournal, readonly save: (state: WorkerJournal) => Promise<void> | void, rpcUrl: string) { this.client = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) }) }
  send(grant: WorkerGrant, signer: () => Promise<SignedWorkerOperation>): Promise<TransactionReceipt> {
    const operation = this.#queue.then(() => this.#send(grant, signer))
    this.#queue = operation.catch(() => {})
    return operation
  }
  async #send(grant: WorkerGrant, signer: () => Promise<SignedWorkerOperation>): Promise<TransactionReceipt> {
    assertWorkerTransaction(grant)
    if (await this.client.getChainId() !== 10143) throw new Error('worker RPC is not Monad testnet')
    let saved = this.state.sends[grant.operationId]
    if (saved === undefined) { saved = await signer(); this.state.sends[grant.operationId] = saved; await this.save(this.state) }
    // Fresh RPC fee/nonce quotes may have advanced after an uncertain response. A
    // retry still reconciles the original raw bytes, never re-signs a new nonce.
    if (saved.operationId !== grant.operationId || saved.kind !== grant.kind || saved.jobId !== grant.jobId.toString() || saved.wallet.toLowerCase() !== grant.wallet.toLowerCase()) throw new Error('saved worker operation identity mismatch')
    const parsed = parseTransaction(saved.raw)
    if (parsed.to?.toLowerCase() !== grant.transaction.to.toLowerCase() || parsed.data !== grant.transaction.data || parsed.chainId !== 10143 || (parsed.value ?? 0n) !== 0n) throw new Error('saved worker operation payload mismatch')
    if (parsed.nonce === undefined || parsed.gas === undefined || parsed.maxFeePerGas === undefined || parsed.maxPriorityFeePerGas === undefined) throw new Error('saved worker transaction is incomplete')
    await validateSignedWorkerTransaction(saved.raw, { ...grant, transaction: { ...grant.transaction, nonce: parsed.nonce, gas: parsed.gas, maxFeePerGas: parsed.maxFeePerGas, maxPriorityFeePerGas: parsed.maxPriorityFeePerGas } })
    let receipt = await this.client.getTransactionReceipt({ hash: saved.hash }).catch(() => undefined)
    if (receipt === undefined) {
      if (await this.client.getTransactionCount({ address: grant.wallet, blockTag: 'latest' }) > saved.nonce) throw new Error('worker nonce consumed; reconcile saved operation before another send')
      await this.client.sendRawTransaction({ serializedTransaction: saved.raw }).catch(() => {})
      receipt = await this.client.waitForTransactionReceipt({ hash: saved.hash, timeout: 60_000 })
    }
    this.state.receipts[grant.operationId] = { status: receipt.status, blockNumber: receipt.blockNumber.toString(), transactionHash: receipt.transactionHash }; await this.save(this.state)
    if (receipt.status !== 'success') throw new Error(`worker transaction reverted: ${saved.hash}`)
    return receipt
  }
}
