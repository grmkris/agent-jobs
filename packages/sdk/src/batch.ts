/**
 * One transaction instead of several (EIP-7702): the wallet points its own code at the canonical `Simple7702Account`
 * (the deployment's `batchDelegate`) and calls `executeBatch` on itself, so an approve, an approve and a publish land
 * together, all or nothing, with one signature. `msg.sender` of every inner call is still the wallet, so nothing on
 * the protocol side changes, and the delegate's ERC-1271 accepts the wallet's own raw EIP-712 signatures.
 *
 * The first batch carries a signed authorization (a type-4 transaction); later ones are ordinary calls to self while
 * the code still points at the delegate. Monad: a delegated account's transaction may not lower its balance below
 * 10 MON by more than the gas fee. Board transactions carry no value, so only gas is spent.
 */
import { type Address, type Hex, encodeFunctionData, parseAbi } from 'viem'
import type { Wallet } from './actions.ts'
import type { TxRequest } from './board-client.ts'

export const simple7702AccountAbi = parseAbi([
  'struct Call { address target; uint256 value; bytes data; }',
  'function executeBatch(Call[] calls)',
])

/** A signed EIP-7702 authorization in viem's shape. */
export interface SignedAuthorization {
  readonly address: Address
  readonly chainId: number
  readonly nonce: number
  readonly r: Hex
  readonly s: Hex
  readonly yParity: number
}

/**
 * Signs an authorization for `delegate` that the wallet itself will submit (so its nonce is the transaction's nonce
 * plus one). Local keys sign with viem; wallets whose key lives elsewhere (a Privy server wallet) register their own
 * signer with `setAuthorizationSigner`.
 */
export type AuthorizationSigner = (delegate: Address, chainId: number, nonce: number) => Promise<SignedAuthorization>

const signers = new WeakMap<object, AuthorizationSigner>()

export function setAuthorizationSigner(wallet: Wallet, signer: AuthorizationSigner) {
  signers.set(wallet, signer)
}

interface Reads {
  getCode(a: { address: Address }): Promise<Hex | undefined>
  getTransactionCount(a: { address: Address; blockTag?: 'pending' }): Promise<number>
  waitForTransactionReceipt(a: { hash: Hex }): Promise<{ status: string }>
}

/** The address an account's code delegates to (`0xef0100 ‖ address`), or null for a plain EOA or a contract. */
export async function delegationOf(reads: Pick<Reads, 'getCode'>, account: Address): Promise<Address | null> {
  const code = (await reads.getCode({ address: account })) ?? '0x'
  if (code.length !== 48 || !code.toLowerCase().startsWith('0xef0100')) return null
  return `0x${code.slice(8)}` as Address
}

/** The `executeBatch` calldata for the board's transactions, in order. */
export function batchCalldata(txs: readonly TxRequest[]): Hex {
  return encodeFunctionData({
    abi: simple7702AccountAbi,
    functionName: 'executeBatch',
    args: [txs.map((t) => ({ target: t.to, value: BigInt(t.value), data: t.data }))],
  })
}

/**
 * Sends the board's transactions as one EIP-7702 batch from `wallet` and waits for it; returns its single hash.
 * One transaction is sent as it is. Throws if the batch reverts (then none of its calls happened).
 */
export async function sendBatch(wallet: Wallet, reads: Reads, txs: readonly TxRequest[], delegate: Address): Promise<Hex> {
  if (txs.length === 0) throw new Error('nothing to send')
  const me = wallet.account.address
  let hash: Hex
  if (txs.length === 1) {
    const [t] = txs as [TxRequest]
    hash = await wallet.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value) })
  } else {
    const data = batchCalldata(txs)
    const current = await delegationOf(reads, me)
    if (current !== null && current.toLowerCase() === delegate.toLowerCase()) {
      hash = await wallet.sendTransaction({ to: me, data })
    } else {
      const chainId = wallet.chain.id
      const custom = signers.get(wallet)
      const authorization = custom !== undefined
        ? await custom(delegate, chainId, (await reads.getTransactionCount({ address: me, blockTag: 'pending' })) + 1)
        : await wallet.signAuthorization({ account: wallet.account, contractAddress: delegate, executor: 'self' })
      hash = await wallet.sendTransaction({ to: me, data, authorizationList: [authorization as never] })
    }
  }
  const receipt = await reads.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${txs.map((t) => t.description).join(' + ')}: ${hash} reverted`)
  return hash
}
