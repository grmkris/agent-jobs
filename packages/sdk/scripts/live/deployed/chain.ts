/** All economic evidence is reconstructed from receipts, including reverted attempts. */
import { type Address, type Hex, type TransactionReceipt, erc20Abi, formatEther, parseTransaction } from 'viem'
import * as sdk from '../../../src/index.ts'
import { CAP_WEI, assertSendBound, budgetRemaining, required, type SendBound } from './guards.ts'
import { RunState } from './state.ts'
import { auditBlocks } from './audit-blocks.ts'

export interface ReceiptEvidence {
  txHash: Hex
  status: string
  gasUsed: string
  effectiveGasPrice: string
  costWei: string
  nativeValueWei: string
  blockNumber: string
  from: Address
  nonce: number
}

function largest(left: bigint, right: bigint): bigint {
  return left > right ? left : right
}

async function readAuditBlocks(
  numbers: readonly bigint[],
  rpcUrl: string,
  batchFetch: typeof fetch,
): Promise<ReturnType<typeof auditBlocks>> {
  const response = await batchFetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      numbers.map((blockNumber, index) => ({
        jsonrpc: '2.0',
        id: index + 1,
        method: 'eth_getBlockByNumber',
        params: [`0x${blockNumber.toString(16)}`, true],
      })),
    ),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error('P8_AUDIT_RPC_REFUSED')
  try {
    return auditBlocks(await response.json(), numbers)
  } catch (error) {
    // Some public RPCs return an incomplete batch when one full transaction block
    // exceeds an internal response limit. Retry the same range in smaller batches;
    // every response is still decoded before its cursor can advance.
    if (!(error instanceof Error) || error.message !== 'P8_AUDIT_BLOCK_MISSING' || numbers.length < 2) throw error
    const middle = Math.ceil(numbers.length / 2)
    const [left, right] = await Promise.all([
      readAuditBlocks(numbers.slice(0, middle), rpcUrl, batchFetch),
      readAuditBlocks(numbers.slice(middle), rpcUrl, batchFetch),
    ])
    return [...left, ...right]
  }
}

export class Chain {
  readonly ctx = sdk.context('monad-testnet', 'main', required('MONAD_TESTNET_RPC_URL'))
  readonly journal: sdk.FlowJournal

  constructor(readonly run: RunState) {
    this.journal = new sdk.FlowJournal(
      this.ctx,
      run.state,
      () => run.save(),
      () => {},
    )
  }

  async initialize(): Promise<void> {
    if ((await this.ctx.publicClient.getChainId()) !== 10143) throw new Error('P8_WRONG_CHAIN')
    const block = await this.ctx.publicClient.getBlockNumber()
    if (this.run.get('firstBlock') === undefined) this.run.set('firstBlock', block)
    await this.audit()
  }

  get receipts(): ReceiptEvidence[] {
    return (this.run.budget.values.receipts as ReceiptEvidence[]) ?? []
  }

  get reservations(): Record<string, string> {
    return (this.run.budget.values.reservations as Record<string, string>) ?? {}
  }

  get bounds(): Record<string, SendBound> {
    return (this.run.budget.values.sendBounds as Record<string, SendBound>) ?? {}
  }

  get receiptBindings(): Record<string, string> {
    return (this.run.budget.values.receiptBindings as Record<string, string>) ?? {}
  }

  async record(hash: Hex): Promise<TransactionReceipt> {
    const receipt = await this.ctx.publicClient.waitForTransactionReceipt({
      hash,
      timeout: 60_000,
    })
    if (!this.receipts.some((item) => item.txHash === hash)) {
      const tx = await this.ctx.publicClient.getTransaction({ hash })
      if (this.receipts.some((item) => item.txHash === hash)) return receipt
      this.run.budgetSet('receipts', [
        ...this.receipts,
        {
          txHash: hash,
          status: receipt.status,
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: receipt.effectiveGasPrice.toString(),
          costWei: (
            receipt.gasUsed * receipt.effectiveGasPrice +
            (receipt.status === 'success' ? tx.value : 0n)
          ).toString(),
          nativeValueWei: (receipt.status === 'success' ? tx.value : 0n).toString(),
          blockNumber: receipt.blockNumber.toString(),
          from: tx.from,
          nonce: tx.nonce,
        },
      ])
    }
    // Receipt costs are authoritative even while reservations remain for reconciliation.
    budgetRemaining(this.receipts, {})
    return receipt
  }

  /** Count all relay traffic conservatively; no attribution guess can undercount a fixture. */
  async audit(): Promise<void> {
    const start = this.run.get<bigint>('auditBlock') ?? this.run.get<bigint>('firstBlock')
    if (start === undefined) return
    const end = await this.ctx.publicClient.getBlockNumber()
    const senders = new Set(
      [this.ctx.deployment.relay, ...(this.run.get<Address[]>('actors') ?? [])].map((item) => item.toLowerCase()),
    )
    // Monad advances faster than one public-client request per block. A bounded
    // JSON-RPC batch keeps the same complete block/receipt audit while avoiding
    // a cursor that can never catch the live tip.
    const rpcUrl = required('MONAD_TESTNET_RPC_URL')
    const batchSize = 25n
    const batchFetch = sdk.throttledFetch(1)
    for (let number = start; number <= end; number += batchSize) {
      const numbers = Array.from(
        { length: Number(end - number + 1n < batchSize ? end - number + 1n : batchSize) },
        (_, index) => number + BigInt(index),
      )
      const blocks = await readAuditBlocks(numbers, rpcUrl, batchFetch)
      for (const block of blocks) {
        for (const tx of block.transactions) {
          if (senders.has(tx.from.toLowerCase())) await this.record(tx.hash)
        }
        this.run.set('auditBlock', block.number + 1n)
      }
    }
    budgetRemaining(this.receipts, {})
  }

  addActor(address: Address): void {
    const actors = this.run.get<Address[]>('actors') ?? []
    if (!actors.some((item) => item.toLowerCase() === address.toLowerCase()))
      this.run.set('actors', [...actors, address])
  }

  async reserve(key: string, maxGas: bigint, nativeValue = 0n): Promise<void> {
    await this.audit()
    const scoped = `${this.run.runId}/${key}`
    const fees = await sdk.transactionFees(this.ctx.publicClient)
    const previous = this.bounds[scoped]
    // Refresh retry quotes without dropping any unresolved prior maximum.
    const bound: SendBound = {
      maxGas: largest(maxGas, BigInt(previous?.maxGas ?? '0')).toString(),
      maxFeePerGas: largest(fees.maxFeePerGas * 2n, BigInt(previous?.maxFeePerGas ?? '0')).toString(),
      nativeValueWei: largest(nativeValue, BigInt(previous?.nativeValueWei ?? '0')).toString(),
      fromBlock:
        previous?.fromBlock ?? (this.run.get<bigint>('auditBlock') ?? this.run.get<bigint>('firstBlock')!).toString(),
    }
    const cost = largest(
      BigInt(bound.maxGas) * BigInt(bound.maxFeePerGas) + BigInt(bound.nativeValueWei),
      BigInt(this.reservations[scoped] ?? '0'),
    )
    const other = { ...this.reservations }
    delete other[scoped]
    if (cost > budgetRemaining(this.receipts, other)) throw new Error('P8_BUDGET_RESERVATION_REFUSED')
    this.run.budgetSet('sendBounds', { ...this.bounds, [scoped]: bound })
    this.run.budgetSet('reservations', { ...this.reservations, [scoped]: cost.toString() })
  }

  async finish(key: string, hashes: Hex[]): Promise<void> {
    for (const hash of hashes) await this.record(hash)
    await this.audit()
    const scoped = `${this.run.runId}/${key}`
    const reserved = this.reservations[scoped]
    if (reserved === undefined) {
      if (hashes.some((hash) => this.receiptBindings[hash] !== scoped)) throw new Error('P8_RECEIPT_HAS_NO_RESERVATION')
      return
    }
    const bound = this.bounds[scoped]
    if (bound === undefined) throw new Error('P8_RESERVATION_REQUIRES_FRESH_BOUND')
    const returned = new Set(hashes)
    const complete = this.receipts.filter(
      (receipt) =>
        (returned.has(receipt.txHash) && this.receiptBindings[receipt.txHash] === undefined) ||
        this.receiptBindings[receipt.txHash] === scoped,
    )
    const transactions = await Promise.all(
      complete.map((receipt) => this.ctx.publicClient.getTransaction({ hash: receipt.txHash })),
    )
    assertSendBound(transactions, bound, reserved)
    this.run.budgetSet('receiptBindings', {
      ...this.receiptBindings,
      ...Object.fromEntries(complete.map((receipt) => [receipt.txHash, scoped])),
    })
    // Retain the reservation after any incomplete/unbounded result, including a lost response.
    const next = { ...this.reservations }
    delete next[scoped]
    this.run.budgetSet('reservations', next)
    budgetRemaining(this.receipts, this.reservations)
  }

  async send(key: string, wallet: sdk.Wallet, tx: sdk.TxRequest): Promise<TransactionReceipt> {
    if (tx.chainId !== 10143 || tx.value !== '0') throw new Error('P8_FIXTURE_TRANSACTION_REFUSED')
    this.addActor(wallet.account.address)
    const saved = this.run.state.sends[key]
    if (saved !== undefined) {
      const mined = await this.journal.mined(key)
      if (mined !== undefined) {
        await this.finish(key, [mined.transactionHash])
        return mined
      }
    }
    const explicit = tx.gas === undefined ? undefined : BigInt(tx.gas)
    const prior = saved === undefined ? undefined : parseTransaction(saved.raw)
    const gas =
      prior?.gas ??
      (await sdk.transactionGas(
        this.ctx.publicClient,
        { account: wallet.account, to: tx.to, data: tx.data, value: 0n },
        sdk.stackGasSizing(this.ctx, tx.to, explicit),
      ))
    await this.reserve(key, gas)
    const sign = wallet.signTransaction.bind(wallet)
    const bounded = Object.assign(Object.create(Object.getPrototypeOf(wallet)), wallet, {
      signTransaction: async (request: Parameters<typeof sign>[0]) => {
        const scoped = `${this.run.runId}/${key}`
        const raw = await sign(request)
        const actual = parseTransaction(raw)
        assertSendBound(
          [
            {
              chainId: actual.chainId,
              gas: actual.gas,
              maxFeePerGas: actual.maxFeePerGas,
              value: actual.value ?? 0n,
            },
          ],
          this.bounds[scoped]!,
          this.reservations[scoped]!,
        )
        return raw
      },
    }) as sdk.Wallet
    // Also inspect retained bytes; retries must not evade the run budget.
    if (saved !== undefined) {
      const scoped = `${this.run.runId}/${key}`
      assertSendBound(
        [
          {
            chainId: prior!.chainId,
            gas: prior!.gas,
            maxFeePerGas: prior!.maxFeePerGas,
            value: prior!.value ?? 0n,
          },
        ],
        this.bounds[scoped]!,
        this.reservations[scoped]!,
      )
    }
    const receipt = await this.journal.send(key, bounded, tx)
    await this.finish(key, [receipt.transactionHash])
    return receipt
  }

  async balance(token: Address, address: Address, blockNumber?: bigint): Promise<bigint> {
    return this.ctx.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    })
  }

  summary() {
    const spent = this.receipts.reduce((sum, item) => sum + BigInt(item.costWei), 0n)
    return {
      capWei: CAP_WEI.toString(),
      spentWei: spent.toString(),
      spentMon: formatEther(spent),
      reservedWei: Object.values(this.reservations)
        .reduce((sum, cost) => sum + BigInt(cost), 0n)
        .toString(),
      accounting:
        'All relay receipts since run start and fixture wallet receipts include gas and successful native value, conservatively including unrelated relay traffic. ERC-20 rewards are separate.',
    }
  }
}
