import { type ReactNode, createContext, useContext, useMemo } from 'react'
import type { Chain, Hex } from 'viem'
import type { BoardApi, Eip1193Provider } from './client.ts'
import { type TxSender, createTxSender } from './send.ts'
import type { TxRequest } from './types.ts'

export interface SidequestContextValue {
  readonly api: BoardApi
  readonly chain: Chain
  readonly rpcUrl?: string
  /** The host's wallet, when connected; null keeps the hooks read-only. */
  readonly provider: Eip1193Provider | null
  readonly address: string | null
  readonly sendBatch?: (txs: TxRequest[]) => Promise<Hex>
  readonly sender: TxSender | null
}

const Ctx = createContext<SidequestContextValue | null>(null)

/**
 * Wraps a host's tree with one board client and its wallet. The host brings any EIP-1193 provider and the address it
 * is connected as (wagmi, Privy, `window.ethereum`); the hooks never open a wallet themselves.
 */
export function SidequestProvider({
  api,
  chain,
  rpcUrl,
  provider,
  address,
  sendBatch,
  children,
}: {
  api: BoardApi
  chain: Chain
  rpcUrl?: string
  provider: Eip1193Provider | null | undefined
  address: string | null | undefined
  sendBatch?: (txs: TxRequest[]) => Promise<Hex>
  children: ReactNode
}) {
  const value = useMemo<SidequestContextValue>(() => {
    const p = provider ?? null
    const a = address ?? null
    return {
      api,
      chain,
      ...(rpcUrl === undefined ? {} : { rpcUrl }),
      provider: p,
      address: a,
      ...(sendBatch === undefined ? {} : { sendBatch }),
      sender: p === null || a === null ? null : createTxSender({ api, provider: p, from: a, chain, ...(rpcUrl === undefined ? {} : { rpcUrl }), ...(sendBatch === undefined ? {} : { sendBatch }) }),
    }
  }, [api, chain, rpcUrl, provider, address, sendBatch])
  return <Ctx value={value}>{children}</Ctx>
}

export function useSidequest(): SidequestContextValue {
  const v = useContext(Ctx)
  if (v === null) throw new Error('useSidequest outside <SidequestProvider>')
  return v
}
