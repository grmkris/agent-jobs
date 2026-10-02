import type * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex, type LocalAccount, type SignedAuthorization, type TransactionReceipt, TransactionReceiptNotFoundError, keccak256 } from 'viem'
import type { Sql } from './store.ts'

export interface RelayRequest { key: string; to: Address; data: Hex; gas?: string; authorizationList?: SignedAuthorization<number>[] }
interface RelayRecord { id: string; raw_tx: Hex; tx_hash: Hex; nonce: number; status: string }

/** Exact signed bytes persist in the reserved object before every relay send. */
export class RelaySender {
  constructor(readonly sql: Sql, readonly ctx: sdk.Ctx, readonly account: LocalAccount, readonly rpcUrl: string) {
    sql.run(`CREATE TABLE IF NOT EXISTS relay_operations (id TEXT PRIMARY KEY, raw_tx TEXT NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE, nonce INTEGER NOT NULL, status TEXT NOT NULL)`)
  }
  async #receipt(hash: Hex): Promise<TransactionReceipt | undefined> {
    try { return await this.ctx.publicClient.getTransactionReceipt({ hash }) }
    catch (e) { if (e instanceof TransactionReceiptNotFoundError) return undefined; throw e }
  }
  async checkPending() {
    for (const op of this.sql.all<RelayRecord>("SELECT * FROM relay_operations WHERE status='pending'")) {
      const receipt = await this.#receipt(op.tx_hash)
      const nonce = receipt === undefined ? await this.ctx.publicClient.getTransactionCount({ address: this.account.address, blockTag: 'latest' }) : 0
      if (receipt !== undefined || nonce > op.nonce) this.sql.run('UPDATE relay_operations SET status=? WHERE id=?', receipt?.status ?? 'dropped', op.id)
      else throw new Error('an earlier relay transaction is pending; retry its original operation')
    }
  }
  submit(request: RelayRequest): Promise<TransactionReceipt> {
    return withRelayNonce(this.account.address, async () => {
      let row = this.sql.all<RelayRecord>('SELECT * FROM relay_operations WHERE id=?', request.key)[0]
      if (row === undefined) {
        await this.checkPending()
        if (this.sql.all("SELECT name FROM sqlite_master WHERE type='table' AND name='sponsor_operations'").length > 0) {
          for (const op of this.sql.all<RelayRecord>("SELECT id,raw_tx,tx_hash,nonce,status FROM sponsor_operations WHERE status='pending'")) {
            if (await this.#receipt(op.tx_hash) === undefined && await this.ctx.publicClient.getTransactionCount({ address: this.account.address, blockTag: 'latest' }) <= op.nonce)
              throw new Error('an earlier sponsored transaction is pending; reconcile it before relaying')
          }
        }
        const nonce = await this.ctx.publicClient.getTransactionCount({ address: this.account.address, blockTag: 'pending' })
        const estimated = await this.ctx.publicClient.estimateGas({ account: this.account, to: request.to, data: request.data, value: 0n,
          ...(request.authorizationList === undefined ? {} : { authorizationList: request.authorizationList }) })
        const floor = request.gas === undefined ? 100_000n : BigInt(request.gas)
        const gas = estimated * 120n / 100n > floor ? estimated * 120n / 100n : floor
        const price = await this.ctx.publicClient.getGasPrice()
        const tx = { chainId: this.ctx.deployment.chainId, to: request.to, data: request.data, value: 0n, nonce, gas, maxFeePerGas: price * 2n, maxPriorityFeePerGas: price }
        const raw = request.authorizationList === undefined
          ? await this.account.signTransaction({ ...tx, type: 'eip1559' })
          : await this.account.signTransaction({ ...tx, type: 'eip7702', authorizationList: request.authorizationList })
        const hash = keccak256(raw)
        this.sql.run("INSERT INTO relay_operations VALUES (?,?,?,?,'pending')", request.key, raw, hash, nonce)
        row = { id: request.key, raw_tx: raw, tx_hash: hash, nonce, status: 'pending' }
      }
      let receipt = await this.#receipt(row.tx_hash)
      if (receipt === undefined) {
        if (row.status === 'dropped' || await this.ctx.publicClient.getTransactionCount({ address: this.account.address, blockTag: 'latest' }) > row.nonce) {
          this.sql.run("UPDATE relay_operations SET status='dropped' WHERE id=?", row.id)
          throw new Error('the relay operation was dropped; its nonce was consumed by another transaction')
        }
        try { await this.ctx.publicClient.sendRawTransaction({ serializedTransaction: row.raw_tx }) } catch { /* Reconcile the persisted hash. */ }
        receipt = await this.ctx.publicClient.waitForTransactionReceipt({ hash: row.tx_hash, timeout: 20_000 })
      }
      this.sql.run('UPDATE relay_operations SET status=? WHERE id=?', receipt.status, row.id)
      if (receipt.status !== 'success') throw new Error(`relay transaction ${row.tx_hash} reverted`)
      return receipt
    })
  }
}

/**
 * Relay sends are serialized by address across sponsorship, rulings, evidence and account upgrades.
 * The Worker keeps these senders in one reserved Board Durable Object; this process queue closes the gap
 * between each sender's pending nonce read and its signed transaction submission.
 */
const queues = new Map<string, Promise<unknown>>()
export function withRelayNonce<T>(relay: Address, fn: () => Promise<T>): Promise<T> {
  const key = relay.toLowerCase()
  const prior = queues.get(key) ?? Promise.resolve()
  const result = prior.then(fn)
  queues.set(key, result.catch(() => undefined))
  return result
}
