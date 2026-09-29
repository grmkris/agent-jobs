import { useQuery } from '@tanstack/react-query'
import { type BoardInfo, data } from './api.ts'
import { registerTokens } from './format.ts'

/** Loads every board's tokens (symbol and decimals as the board read them on-chain) into the amount formatter. */
export function useTokenRegistry(): void {
  const q = useQuery({ queryKey: ['data-boards'], queryFn: () => data<{ boards: BoardInfo[] }>('/data/boards'), staleTime: 300_000 })
  // Idempotent: a known address keeps its first entry.
  if (q.data !== undefined) registerTokens(q.data.boards.flatMap((b) => b.tokens))
}
