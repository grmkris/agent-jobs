/**
 * A client for the hosted board's REST API (`POST /api/<tool>`), the same tools the MCP server exposes, plus the
 * wallet-side helpers a client needs to act on its answers: sign the EIP-712 JSON it returns and send the unsigned
 * transactions it returns.
 */
import type { Account, Hex } from 'viem'
import type { Wallet } from './actions.ts'

export class BoardApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}

export interface TxRequest {
  readonly description: string
  readonly chainId: number
  readonly to: Hex
  readonly data: Hex
  readonly value: string
}

export function boardClient(baseUrl: string) {
  let session: string | undefined
  const call = async <T = any>(tool: string, args: Record<string, unknown> = {}): Promise<T> => {
    const res = await fetch(`${baseUrl}/api/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(session === undefined ? {} : { authorization: `Bearer ${session}` }) },
      body: JSON.stringify(args),
    })
    const body = (await res.json()) as { ok: boolean; result?: T; code?: string; message?: string }
    if (!body.ok) throw new BoardApiError(body.code ?? String(res.status), body.message ?? 'request failed')
    return body.result as T
  }
  return {
    call,
    /** SIWE sign-in; later calls carry the session. */
    async signIn(account: Account & { signMessage: NonNullable<Account['signMessage']> }) {
      const { message } = await call<{ message: string }>('auth_challenge', { address: account.address })
      const signature = await account.signMessage({ message })
      const result = await call<{ session: string }>('auth_login', { message, signature })
      session = result.session
      return result
    },
  }
}

/** Signs the `eth_signTypedData_v4` JSON the board returns (decimal strings become bigints for integer fields). */
export async function signTypedDataJson(wallet: Wallet, json: string): Promise<Hex> {
  const parsed = JSON.parse(json) as {
    types: Record<string, Array<{ name: string; type: string }>>
    primaryType: string
    domain: Record<string, unknown>
    message: Record<string, unknown>
  }
  const { EIP712Domain: _domain, ...types } = parsed.types
  const fields = types[parsed.primaryType] ?? []
  const message: Record<string, unknown> = { ...parsed.message }
  for (const f of fields) {
    if (/^u?int\d*$/.test(f.type) && typeof message[f.name] === 'string') message[f.name] = BigInt(message[f.name] as string)
  }
  const sign = wallet.signTypedData as (args: Record<string, unknown>) => Promise<Hex>
  return sign({ domain: parsed.domain, types, primaryType: parsed.primaryType, message })
}

/** Sends the board's unsigned transactions in order from `wallet`, waiting for each; returns the hashes. */
export async function sendAll(
  wallet: Wallet,
  publicClient: { waitForTransactionReceipt(a: { hash: Hex }): Promise<{ status: string }> },
  txs: readonly TxRequest[],
): Promise<Hex[]> {
  const hashes: Hex[] = []
  for (const tx of txs) {
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${tx.description}: ${hash} reverted`)
    hashes.push(hash)
  }
  return hashes
}
