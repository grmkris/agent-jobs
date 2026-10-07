import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { expect, test } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex, keccak256, parseTransaction, TransactionReceiptNotFoundError } from 'viem'
import { RelaySender } from './relay.ts'
import { fromNodeSqlite } from './store.ts'

test('faucet and native drip sends share nonce serialization and persist bytes before broadcast', async () => {
  const db = new DatabaseSync(':memory:'), sql = fromNodeSqlite(db)
  try {
    const relay = privateKeyToAccount(`0x${'1'.repeat(64)}`)
    const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
    let nonce = 0
    const receipts = new Map<Hex, unknown>(), sent: ReturnType<typeof parseTransaction>[] = []
    const client = {
      ...base.publicClient,
      getTransactionCount: async () => nonce,
      estimateGas: async () => 21000n,
      call: async () => ({ data: '0x' }),
      getGasPrice: async () => 2_000_000_000n,
      getBlock: async () => ({ baseFeePerGas: 1_000_000_000n }),
      estimateMaxPriorityFeePerGas: async () => 1_000_000_000n,
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const receipt = receipts.get(hash)
        if (!receipt) throw new TransactionReceiptNotFoundError({ hash })
        return receipt
      },
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => receipts.get(hash),
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        const hash = keccak256(serializedTransaction), tx = parseTransaction(serializedTransaction)
        expect(sql.all('SELECT * FROM relay_operations WHERE tx_hash=?', hash)[0]).toMatchObject({ raw_tx: serializedTransaction, nonce, status: 'pending' })
        expect(tx.nonce).toBe(nonce++)
        sent.push(tx)
        receipts.set(hash, { transactionHash: hash, status: 'success' })
        return hash
      },
    }
    const ctx = { ...base, publicClient: client } as unknown as sdk.Ctx
    const first = new RelaySender(sql, ctx, relay, 'http://127.0.0.1:1')
    const second = new RelaySender(sql, ctx, relay, 'http://127.0.0.1:1')
    const drip = { key: 'drip:public:wallet', to: relay.address, data: '0x' as Hex, value: '50000000000000000' }
    const faucet = { key: 'faucet:wallet:0', to: base.deployment.testnetFaucet!, data: '0x12345678' as Hex }
    await Promise.all([first.submit(drip), second.submit(faucet)])
    expect(sent.map(tx => tx.nonce)).toEqual([0, 1])
    expect(sent[0]?.value).toBe(50_000_000_000_000_000n)
    await second.submit(drip)
    expect(sent).toHaveLength(2)
    await expect(first.submit({ ...drip, key: 'too-much', value: '100000000000000000' })).rejects.toThrow('Invalid testnet relay value')
  } finally { db.close() }
})
