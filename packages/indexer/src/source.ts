/**
 * Where logs come from. `hyperSync` is the real source (Envio HyperSync, `POST /query`); tests pass their own pages.
 * The chain RPC answers the finalized head and block hashes (the divergence guard).
 */
import type { Address, Hex } from 'viem'
import type { RawLog } from './events.ts'

export interface LogPage {
  readonly logs: readonly RawLog[]
  /** The next block to ask for; the page covered [fromBlock, nextBlock). */
  readonly nextBlock: number
}

export interface LogSource {
  logs(q: { fromBlock: number; toBlock: number; addresses: readonly string[] }): Promise<LogPage>
}

export interface ChainHead {
  finalizedBlock(): Promise<number>
  blockHash(block: number): Promise<Hex | null>
}

const FIELDS = ['block_number', 'log_index', 'transaction_hash', 'address', 'topic0', 'topic1', 'topic2', 'topic3', 'data']

export function hyperSync(url: string, token: string): LogSource {
  return {
    async logs({ fromBlock, toBlock, addresses }) {
      const res = await fetch(`${url.replace(/\/$/, '')}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          from_block: fromBlock,
          to_block: toBlock,
          logs: [{ address: addresses }],
          field_selection: { log: FIELDS },
        }),
      })
      if (!res.ok) throw new Error(`hypersync: HTTP ${res.status}`)
      const body = (await res.json()) as { data?: Array<{ logs?: RawLog[] }>; next_block: number }
      return { logs: (body.data ?? []).flatMap((d) => d.logs ?? []), nextBlock: body.next_block }
    },
  }
}

export function rpcHead(rpcUrl: string): ChainHead {
  const call = async (method: string, params: unknown[]) => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const body = (await res.json()) as { result?: { number: Hex; hash: Hex } | null; error?: { message: string } }
    if (body.error !== undefined) throw new Error(`rpc ${method}: ${body.error.message}`)
    return body.result ?? null
  }
  return {
    async finalizedBlock() {
      const b = await call('eth_getBlockByNumber', ['finalized', false])
      if (b === null) throw new Error('rpc: no finalized block')
      return Number(BigInt(b.number))
    },
    async blockHash(block) {
      const b = await call('eth_getBlockByNumber', [`0x${block.toString(16)}`, false])
      return b?.hash ?? null
    },
  }
}

export type { Address }
