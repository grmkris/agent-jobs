import * as sdk from '@sidequest/sdk'
import { type Hex, type LocalAccount, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/** The v1 arbitrator uses its dedicated key. */
export function arbiterAccounts(deployment: sdk.Deployment, env: NodeJS.ProcessEnv): LocalAccount[] {
  const names = ['V1_ARBITRATOR_PRIVATE_KEY']
  const accounts = names.map(name => {
    const key = env[name]
    if (key === undefined || key === '') throw new Error(`${name} is not set`)
    if (!/^0x[\da-fA-F]{64}$/.test(key)) throw new Error(`${name} is invalid`)
    try { return privateKeyToAccount(key as Hex) }
    catch { throw new Error(`${name} is invalid`) }
  })
  return accounts.filter((account, index) => accounts.findIndex(other => other.address === account.address) === index)
}

type CancellationReads = Pick<PublicClient, 'getChainId' | 'getBalance' | 'estimateGas' | 'estimateFeesPerGas' | 'waitForTransactionReceipt'>

/** The account that signs the ruling also pays cancellation gas. Never attempt an unfunded retry. */
export async function sendFundedCancellation(wallet: sdk.Wallet, reads: CancellationReads, transaction: sdk.TxRequest): Promise<void> {
  if (transaction.chainId !== wallet.chain.id || transaction.value !== '0') throw new Error('Ruling cancellation chain/value refused')
  let gas: bigint, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint, balance: bigint
  try {
    if (await reads.getChainId() !== transaction.chainId) throw new Error('chain mismatch')
    const [estimate, fees, available] = await Promise.all([
      reads.estimateGas({ account: wallet.account, to: transaction.to, data: transaction.data, value: 0n }),
      reads.estimateFeesPerGas({ chain: wallet.chain, type: 'eip1559' }),
      reads.getBalance({ address: wallet.account.address, blockTag: 'pending' }),
    ])
    const estimated = (estimate * 120n + 99n) / 100n, requested = BigInt(transaction.gas ?? '0')
    gas = estimated > requested ? estimated : requested
    if (gas < 100_000n) gas = 100_000n
    maxFeePerGas = fees.maxFeePerGas
    maxPriorityFeePerGas = fees.maxPriorityFeePerGas
    balance = available
  } catch { throw new Error('Ruling cancellation gas reserve could not be checked') }
  if (maxFeePerGas <= 0n || balance < gas * maxFeePerGas) throw new Error('Fund the arbitrator cancellation gas reserve before retrying')
  // Pin the checked worst-case cost in the send; do not let the wallet silently choose a larger gas limit/fee.
  let hash: Hex
  try { hash = await wallet.sendTransaction({ to: transaction.to, data: transaction.data, value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas }) }
  catch { throw new Error('Ruling cancellation send failed; reconcile the nonce before retrying') }
  let receipt: Awaited<ReturnType<CancellationReads['waitForTransactionReceipt']>>
  try { receipt = await reads.waitForTransactionReceipt({ hash }) }
  catch { throw new Error('Ruling cancellation receipt unavailable; reconcile the nonce before retrying') }
  if (receipt.status !== 'success') throw new Error('Ruling cancellation reverted')
}

/** Same production path used by main.ts; no sender/key/RPC fallback. */
export function cancellationSender(network: sdk.Network, account: LocalAccount, rpcUrl: string) {
  if (!rpcUrl || rpcUrl === 'unset') throw new Error('Arbitrator cancellation RPC is not configured')
  const wallet = sdk.wallet(network, account, rpcUrl)
  const { publicClient } = sdk.context(network, 'main', rpcUrl)
  return (transaction: sdk.TxRequest) => sendFundedCancellation(wallet, publicClient, transaction)
}
