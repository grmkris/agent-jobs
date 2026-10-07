/**
 * Sending a board's unsigned transactions from a host's wallet and reporting each hash back, so the board reconciles
 * from the chain. Sequential by default; a host that can batch (EIP-7702 through Privy, EIP-5792 `wallet_sendCalls`)
 * passes `sendBatch`. A confirmed transaction is remembered before it is reported: a failed report never causes a
 * resend.
 */
import { type Chain, type Hex, createPublicClient, http } from 'viem'
import type { BoardApi, Eip1193Provider } from './client.ts'
import type { TxRequest } from './types.ts'

export interface TxSenderOptions {
  readonly api: BoardApi
  readonly provider: Eip1193Provider
  readonly from: string
  readonly chain: Chain
  /** RPC to wait for receipts on; default the chain's public RPC. */
  readonly rpcUrl?: string
  /** Several transactions as one; the hash of the one transaction. */
  readonly sendBatch?: (txs: TxRequest[]) => Promise<Hex>
  readonly waitForReceipt?: (hash: Hex) => Promise<{ status: 'success' | 'reverted' }>
}

export interface SendProgress {
  readonly index: number
  readonly description: string
  readonly hash: Hex
  readonly reported: boolean
}

export class SendError extends Error {
  constructor(
    message: string,
    readonly sent: readonly SendProgress[],
  ) {
    super(message)
  }
}

export function createTxSender(options: TxSenderOptions) {
  const reads = createPublicClient({ chain: options.chain, transport: http(options.rpcUrl) })
  const wait =
    options.waitForReceipt ??
    (async (hash: Hex) => ({ status: (await reads.waitForTransactionReceipt({ hash })).status }))
  const report = async (taskId: string, hash: Hex) => {
    await options.api.tool('report_transaction', { taskId, txHash: hash })
  }
  return {
    /** Sends `txs` for `taskId` (batched when possible) and reports each hash; resolves with the hashes. */
    async send(taskId: string, txs: readonly TxRequest[], onProgress?: (p: SendProgress) => void): Promise<Hex[]> {
      const sent: SendProgress[] = []
      const record = (index: number, description: string, hash: Hex, reported: boolean) => {
        const p = { index, description, hash, reported }
        sent.push(p)
        onProgress?.(p)
      }
      if (options.sendBatch !== undefined && txs.length > 1) {
        const hash = await options.sendBatch([...txs])
        const receipt = await wait(hash)
        if (receipt.status !== 'success')
          throw new SendError(`batch reverted: ${hash} (none of the steps happened)`, sent)
        record(0, txs.map((t) => t.description).join(' + '), hash, false)
        try {
          await report(taskId, hash)
        } catch (e) {
          throw new SendError(`sent ${hash} but could not report it: ${(e as Error).message}`, sent)
        }
        sent[0] = { ...(sent[0] as SendProgress), reported: true }
        return [hash]
      }
      const hashes: Hex[] = []
      for (const [i, tx] of txs.entries()) {
        const hash = (await options.provider.request({
          method: 'eth_sendTransaction',
          params: [{ from: options.from, to: tx.to, data: tx.data, value: '0x0' }],
        })) as Hex
        const receipt = await wait(hash)
        if (receipt.status !== 'success') throw new SendError(`${tx.description}: ${hash} reverted`, sent)
        record(i, tx.description, hash, false)
        try {
          await report(taskId, hash)
        } catch (e) {
          throw new SendError(`${tx.description}: sent ${hash} but could not report it: ${(e as Error).message}`, sent)
        }
        sent[i] = { ...(sent[i] as SendProgress), reported: true }
        hashes.push(hash)
      }
      return hashes
    },
  }
}

export type TxSender = ReturnType<typeof createTxSender>
