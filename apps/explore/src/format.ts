import { formatUnits } from 'viem'
import type { CallBudgetTerms, TokenBudgetTerms } from './api.ts'
import { deployment, isMainnet } from './wallet.ts'

/** The deployment's reward tokens: Circle USDC on mainnet; the mUSD / mEUR test tokens on testnet. */
export const TOKENS: Record<string, { symbol: string; decimals: number; usd: number | null }> = isMainnet
  ? {
      [deployment.rewardTokens[0]?.toLowerCase() ?? '']: { symbol: 'USDC', decimals: 6, usd: 1 },
      [deployment.factory.toLowerCase()]: { symbol: 'FACTORY', decimals: 18, usd: null },
    }
  : {
      [deployment.rewardTokens[0]?.toLowerCase() ?? '']: { symbol: 'mUSD', decimals: 6, usd: 1 },
      [deployment.rewardTokens[1]?.toLowerCase() ?? '']: { symbol: 'mEUR', decimals: 6, usd: null },
      [deployment.factory.toLowerCase()]: { symbol: 'FACTORY', decimals: 18, usd: null },
    }

export function tokenInfo(address: string | null | undefined) {
  return TOKENS[(address ?? '').toLowerCase()] ?? { symbol: 'token', decimals: 18, usd: null }
}

/** "7 mUSD (≈ $7, test token)" — the USD value next to the amount where one exists. */
export function amount(value: string | null | undefined, token: string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  const t = tokenInfo(token)
  const n = formatUnits(BigInt(value), t.decimals)
  if (t.usd === null) return `${n} ${t.symbol}`
  return isMainnet ? `${n} ${t.symbol}` : `${n} ${t.symbol} (≈ $${(Number(n) * t.usd).toFixed(2)}, test token)`
}

/** An execution budget's cap as people read it; a call budget names the function and contract it may call. */
export function budgetCap(eb: TokenBudgetTerms | CallBudgetTerms): string {
  if (eb.kind !== 'call') return amount(eb.cap, eb.token)
  const name = /function\s+(\w+)/.exec(eb.function ?? '')?.[1] ?? 'call'
  return `${formatUnits(BigInt(eb.cap), 18)} MON for ${name}() on ${eb.target.slice(0, 8)}…${eb.target.slice(-4)}`
}

export const bond = (value: string | null | undefined) => (value === null || value === undefined ? '—' : `${formatUnits(BigInt(value), 18)} FACTORY`)

export function when(unix: number | null | undefined): string {
  if (unix === null || unix === undefined || unix === 0) return '—'
  const d = new Date(unix * 1000)
  const diff = unix - Date.now() / 1000
  const rel = Math.abs(diff) < 3600 ? `${Math.round(Math.abs(diff) / 60)} min` : Math.abs(diff) < 86400 ? `${Math.round(Math.abs(diff) / 3600)} h` : `${Math.round(Math.abs(diff) / 86400)} d`
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC (${diff >= 0 ? `in ${rel}` : `${rel} ago`})`
}
