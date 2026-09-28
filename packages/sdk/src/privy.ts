/**
 * A Privy server wallet as an ordinary viem wallet (demo path 3 in docs/wallet-matrix.md): signing and sending go to
 * Privy's wallet RPC (`POST /v1/wallets/<id>/rpc`), every read goes to the caller's RPC. The key never leaves
 * Privy; its policies (chain, `to`, function, value caps) apply to every request. Because the result is a plain
 * `Wallet`, every SDK action, `sendAll`, `signTypedDataJson` and board sign-in work unchanged.
 */
import { type Address, type Hex, type JsonRpcAccount, createPublicClient, createWalletClient, custom, http } from 'viem'
import type { Wallet } from './actions.ts'
import { setAuthorizationSigner } from './batch.ts'
import { chains, throttledFetch } from './client.ts'
import type { Network } from './deployment.ts'

export interface PrivyWalletConfig {
  readonly appId: string
  readonly appSecret: string
  readonly walletId: string
  readonly address: Address
}

const PRIVY_API = 'https://api.privy.io/v1'

export class PrivyError extends Error {}

/** One call to Privy's wallet RPC; returns its `data`. */
async function privyRpc(cfg: PrivyWalletConfig, body: Record<string, unknown>): Promise<Record<string, string>> {
  const res = await fetch(`${PRIVY_API}/wallets/${cfg.walletId}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${cfg.appId}:${cfg.appSecret}`)}`,
      'privy-app-id': cfg.appId,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as { data?: Record<string, string>; error?: string; message?: string }
  if (!res.ok || json.data === undefined) throw new PrivyError(`privy ${String(body.method)}: HTTP ${res.status} ${json.error ?? json.message ?? ''}`)
  return json.data
}

export function privyWallet(network: Network, cfg: PrivyWalletConfig, rpcUrl: string): Wallet {
  const chain = chains[network]
  const reads = createPublicClient({ chain, transport: http(rpcUrl, { fetchFn: throttledFetch() }) })
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const p = (params ?? []) as unknown[]
      switch (method) {
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [cfg.address]
        case 'eth_chainId':
          return `0x${chain.id.toString(16)}`
        case 'personal_sign': {
          // viem sends [hexMessage, address]
          const data = await privyRpc(cfg, { method: 'personal_sign', params: { message: p[0] as Hex, encoding: 'hex' } })
          return data.signature
        }
        case 'eth_signTypedData_v4': {
          const td = JSON.parse(p[1] as string) as { types: unknown; primaryType: string; domain: unknown; message: unknown }
          const data = await privyRpc(cfg, {
            method: 'eth_signTypedData_v4',
            params: { typed_data: { types: td.types, primary_type: td.primaryType, domain: td.domain, message: td.message } },
          })
          return data.signature
        }
        case 'eth_sendTransaction': {
          const tx = p[0] as {
            to?: Address
            data?: Hex
            value?: Hex
            gas?: Hex
            authorizationList?: Array<{ address: Address; chainId: Hex; nonce: Hex; r: Hex; s: Hex; yParity: Hex }>
          }
          const data = await privyRpc(cfg, {
            method: 'eth_sendTransaction',
            caip2: `eip155:${chain.id}`,
            params: {
              transaction: {
                to: tx.to,
                ...(tx.data === undefined ? {} : { data: tx.data }),
                value: tx.value ?? '0x0',
                ...(tx.gas === undefined ? {} : { gas_limit: tx.gas }),
                // EIP-7702 (a batch's first send): type 4 with the authorization Privy signed.
                ...(tx.authorizationList === undefined
                  ? {}
                  : {
                      type: 4,
                      authorization_list: tx.authorizationList.map((a) => ({
                        contract: a.address,
                        chain_id: Number(a.chainId),
                        nonce: Number(a.nonce),
                        r: a.r,
                        s: a.s,
                        y_parity: Number(a.yParity),
                      })),
                    }),
              },
            },
          })
          return data.hash
        }
        default:
          return reads.request({ method, params } as never)
      }
    },
  })
  const account: JsonRpcAccount = { address: cfg.address, type: 'json-rpc' }
  const wallet = createWalletClient({ account, chain, transport }) as unknown as Wallet
  // The key is in Privy, so an EIP-7702 authorization is signed by Privy too (`sendBatch` uses it).
  setAuthorizationSigner(wallet, async (delegate, chainId, nonce) => {
    const data = (await privyRpc(cfg, {
      method: 'eth_sign7702Authorization',
      params: { contract: delegate, chain_id: chainId, nonce },
    })) as unknown as { authorization: Record<string, string | number> }
    const a = data.authorization
    return {
      address: ((a.contract ?? a.address) as Address),
      chainId: Number(a.chain_id),
      nonce: Number(a.nonce),
      r: a.r as Hex,
      s: a.s as Hex,
      yParity: Number(a.y_parity),
    }
  })
  return wallet
}

/** The account shape board sign-in takes, signing through the wallet (Privy's `personal_sign`). */
export function signerOf(w: Wallet) {
  return { address: w.account.address, type: 'json-rpc' as const, signMessage: ({ message }: { message: string }) => w.signMessage({ message }) }
}
