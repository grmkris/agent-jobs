/** Node runtime glue for approved companion submissions. Nothing sends until the
 * API's provider capability is enabled; the provider gateway enforces job grants.
 */
import { sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { existsSync, readFileSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { type Address, type Hex, createPublicClient, http } from 'viem'
import { monadTestnet } from 'viem/chains'
import { deployment, stack } from './deployment.ts'
import { lowSDer } from './companion-protocol.ts'
import { WorkerOperationJournal, signWorkerTransaction, type WorkerGrant, type WorkerJournal } from './agent-wallet.ts'

export interface CompanionWalletState { apiOrigin: string; managedId?: string; runtimeToken?: string; privyAppId?: string; gatewayEnabled?: boolean; agent?: Record<string, unknown> }
export async function executeCompanionWalletOperation(state: CompanionWalletState, privateKey: KeyObject, statePath: string, save: (path: string, value: unknown) => void, kind: 'submit' | 'dispute', input: Record<string, unknown>) {
  if (state.gatewayEnabled !== true) throw new Error(`Automatic signing is unavailable. Open ${state.apiOrigin}/approvals and approve the ${kind} operation with the agent wallet.`)
  const walletId = state.agent?.privyWalletId ?? state.agent?.walletId
  if (!state.managedId || !state.runtimeToken || !state.privyAppId || typeof walletId !== 'string' || typeof state.agent?.walletAddress !== 'string') throw new Error('paired wallet gateway metadata is incomplete')
  const tx = input.transaction as { data: Hex; to: Address; chainId: number; gas?: string; value?: string } | undefined
  if (!tx || typeof input.operationId !== 'string' || typeof input.jobId !== 'string') throw new Error('provide the exact prepared operationId, jobId and transaction returned by Hireling')
  if (tx.chainId !== 10143 || (tx.value !== undefined && BigInt(tx.value) !== 0n)) throw new Error('worker wallet operations require testnet and zero value')
  const config = deployment('monad-testnet'), target = kind === 'submit' ? config.core : stack(config, 'main').evaluator
  const wallet = state.agent.walletAddress as Address, rpcUrl = process.env.HIRELING_RPC_URL ?? monadTestnet.rpcUrls.default.http[0]
  const reads = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) })
  const journalPath = `${statePath}.journal.json`, lockPath = `${statePath}.send.lock`, fd = openSync(lockPath, 'wx', 0o600)
  try {
    const fees = await reads.estimateFeesPerGas(), nonce = await reads.getTransactionCount({ address: wallet, blockTag: 'pending' })
    const gas = tx.gas === undefined ? await reads.estimateGas({ account: wallet, to: tx.to, data: tx.data }) : BigInt(tx.gas)
    const grant: WorkerGrant = { operationId: input.operationId, kind, jobId: BigInt(input.jobId), wallet, target, transaction: { chainId: 10143, to: tx.to, data: tx.data, value: '0', nonce, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas } }
    const journal: WorkerJournal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) as WorkerJournal : { sends: {}, receipts: {} }
    const operations = new WorkerOperationJournal(journal, next => save(journalPath, next), rpcUrl)
    const receipt = await operations.send(grant, () => signWorkerTransaction({ apiOrigin: state.apiOrigin, managedId: state.managedId!, runtimeToken: state.runtimeToken!, appId: state.privyAppId!, walletId, signAuthorization: async payload => lowSDer(sign('sha256', Buffer.from(payload), privateKey)).toString('base64') }, grant))
    return { operationId: grant.operationId, txHash: receipt.transactionHash, status: receipt.status, blockNumber: receipt.blockNumber.toString() }
  } finally { closeSync(fd); unlinkSync(lockPath) }
}
