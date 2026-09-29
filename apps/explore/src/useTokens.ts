import { useQuery } from '@tanstack/react-query'
import { type Address, erc20Abi, isAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import { type BoardInfo, data } from './api.ts'
import { type TokenMeta, registerTokens, tokenMeta } from './format.ts'
import { chain } from './wallet.ts'

/** Loads every board's tokens (symbol and decimals as the board read them on-chain) into the amount formatter. */
export function useTokenRegistry(): void {
  const q = useQuery({ queryKey: ['data-boards'], queryFn: () => data<{ boards: BoardInfo[] }>('boards'), staleTime: 300_000 })
  // Idempotent: a known address keeps its first entry.
  if (q.data !== undefined) registerTokens(q.data.boards.flatMap((b) => b.tokens))
}

/**
 * Any ERC-20 by address (ADR-0010): its symbol and decimals, read from the chain the first time and added to the
 * formatter (as unverified unless the deployment lists it), so every amount in it reads right. `'reading'` until the
 * chain answers; `'none'` for text that is not an address, or an address that answers neither `symbol` nor `decimals`.
 */
export function useToken(address: string | null | undefined): TokenMeta | 'reading' | 'none' {
  const a = (address ?? '').trim().toLowerCase()
  const valid = isAddress(a, { strict: false })
  const known = valid ? tokenMeta(a) : undefined
  const token = a as Address
  const reads = useReadContracts({
    contracts: [
      { address: token, abi: erc20Abi, functionName: 'symbol', chainId: chain.id },
      { address: token, abi: erc20Abi, functionName: 'decimals', chainId: chain.id },
    ],
    query: { enabled: valid && known === undefined, staleTime: Infinity, retry: 1 },
  })
  if (!valid) return 'none'
  if (known !== undefined) return known
  const [symbol, decimals] = reads.data ?? []
  if (symbol?.status === 'success' && decimals?.status === 'success') {
    registerTokens([{ address: a, symbol: symbol.result, decimals: decimals.result }])
    return tokenMeta(a) ?? 'none'
  }
  return reads.isFetching || reads.data === undefined ? 'reading' : 'none'
}
