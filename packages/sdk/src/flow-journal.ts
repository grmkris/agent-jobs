/** Local live-run journal: exact signed bytes are durable before a broadcast and retries reconcile that hash. */
import { type Abi, type Address, type Hex, type SignedAuthorization, type TransactionReceipt, TransactionReceiptNotFoundError, encodeFunctionData, keccak256 } from 'viem'
import type { Ctx, Wallet } from './actions.ts'
import type { TxRequest } from './board-client.ts'
import { stackGasSizing, transactionFees, transactionGas } from './transaction-cost.ts'

export interface FlowState { binding: string; values: Record<string, unknown>; sends: Record<string, { raw: Hex; hash: Hex; nonce: number; wallet: Address }> }
export const flowJson = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? { $bigint: v.toString() } : v, 2)
export const parseFlowJson = (text: string): FlowState => JSON.parse(text, (_key, v) => v !== null && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.$bigint === 'string' ? BigInt(v.$bigint) : v) as FlowState

export class FlowJournal {
  constructor(readonly ctx: Ctx, readonly state: FlowState, readonly save: (state: FlowState) => void, readonly log: (label: string, hash: Hex) => void) {}
  async once<T>(key: string, make: () => Promise<T>): Promise<T> {
    if (Object.hasOwn(this.state.values, key)) return this.state.values[key] as T
    const value = await make(); this.state.values[key] = value; this.save(this.state); return value
  }
  async #receipt(hash: Hex): Promise<TransactionReceipt | undefined> {
    try { return await this.ctx.publicClient.getTransactionReceipt({ hash }) }
    catch (e) { if (e instanceof TransactionReceiptNotFoundError) return undefined; throw e }
  }
  #recordReceipt(key: string, receipt: TransactionReceipt) {
    if (!Object.hasOwn(this.state.values, `receipt/${key}`)) {
      this.state.values[`receipt/${key}`] = receipt
      this.save(this.state)
    }
  }
  /** A saved signed transaction alone is never proof of completion. */
  async mined(key: string): Promise<TransactionReceipt | undefined> {
    const saved = this.state.sends[key]
    if (saved === undefined) return undefined
    const receipt = await this.#receipt(saved.hash)
    if (receipt === undefined) return undefined
    if (receipt.status !== 'success') throw new Error(`${key}: ${saved.hash} reverted`)
    this.#recordReceipt(key, receipt)
    return receipt
  }
  async send(key: string, wallet: Wallet, tx: Pick<TxRequest, 'to' | 'data' | 'gas' | 'value'>, authorizationList?: SignedAuthorization<number>[]): Promise<TransactionReceipt> {
    if (this.ctx.deployment.chainId !== 10143 || await this.ctx.publicClient.getChainId() !== 10143)
      throw new Error('Live flow sends are restricted to Monad testnet (10143)')
    let saved = this.state.sends[key]
    if (saved !== undefined && saved.wallet.toLowerCase() !== wallet.account.address.toLowerCase()) throw new Error(`${key}: journal wallet mismatch`)
    if (saved === undefined) {
      const client = this.ctx.publicClient
      const explicitGas = tx.gas === undefined ? undefined : BigInt(tx.gas)
      const sizing = stackGasSizing(this.ctx, tx.to, explicitGas)
      const gas = await transactionGas(client, { account: wallet.account, to: tx.to, data: tx.data, value: BigInt(tx.value),
        ...(authorizationList === undefined ? {} : { authorizationList }) }, sizing)
      const { maxFeePerGas, maxPriorityFeePerGas } = await transactionFees(client)
      const nonce = await client.getTransactionCount({ address: wallet.account.address, blockTag: 'pending' })
      const request = { chainId: this.ctx.deployment.chainId, to: tx.to, data: tx.data, value: BigInt(tx.value), gas, nonce, maxFeePerGas, maxPriorityFeePerGas }
      const raw = authorizationList === undefined
        ? await wallet.signTransaction({ ...request, type: 'eip1559' })
        : await wallet.signTransaction({ ...request, type: 'eip7702', authorizationList })
      saved = { raw, hash: keccak256(raw), nonce, wallet: wallet.account.address }
      this.state.sends[key] = saved; this.save(this.state)
    }
    let receipt = await this.#receipt(saved.hash)
    if (receipt === undefined) {
      if (await this.ctx.publicClient.getTransactionCount({ address: saved.wallet, blockTag: 'latest' }) > saved.nonce)
        throw new Error(`${key}: saved nonce was consumed without this receipt; reconcile manually, never create another send`)
      this.log(key, saved.hash)
      try { await this.ctx.publicClient.sendRawTransaction({ serializedTransaction: saved.raw }) } catch { /* Same signed bytes may already be accepted. */ }
      receipt = await this.ctx.publicClient.waitForTransactionReceipt({ hash: saved.hash, timeout: 60_000 })
    }
    this.log(key, saved.hash)
    if (receipt.status !== 'success') throw new Error(`${key}: ${saved.hash} reverted`)
    this.#recordReceipt(key, receipt)
    return receipt
  }
  contract(key: string, wallet: Wallet, address: Address, abi: Abi, functionName: string, args: readonly unknown[], gas?: bigint) {
    return this.send(key, wallet, { to: address, data: encodeFunctionData({ abi, functionName, args }), value: '0', ...(gas === undefined ? {} : { gas: gas.toString() }) })
  }
  async transactions(key: string, wallet: Wallet, txs: readonly TxRequest[]) {
    if (txs.some(tx => tx.chainId !== 10143)) throw new Error('Prepared transaction chain must be 10143')
    const receipts: TransactionReceipt[] = []
    for (const [i, tx] of txs.entries()) receipts.push(await this.send(`${key}/${i}`, wallet, tx))
    return receipts
  }
}
