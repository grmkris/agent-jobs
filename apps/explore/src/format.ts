import { formatUnits } from 'viem'
import { deployment } from './wallet.ts'

const TOKENS: Record<string, { symbol: string; decimals: number; usd: number | null }> = {
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
  return t.usd === null ? `${n} ${t.symbol}` : `${n} ${t.symbol} (≈ $${(Number(n) * t.usd).toFixed(2)}, test token)`
}

export const bond = (value: string | null | undefined) => (value === null || value === undefined ? '—' : `${formatUnits(BigInt(value), 18)} FACTORY`)

export function when(unix: number | null | undefined): string {
  if (unix === null || unix === undefined || unix === 0) return '—'
  const d = new Date(unix * 1000)
  const diff = unix - Date.now() / 1000
  const rel = Math.abs(diff) < 3600 ? `${Math.round(Math.abs(diff) / 60)} min` : Math.abs(diff) < 86400 ? `${Math.round(Math.abs(diff) / 3600)} h` : `${Math.round(Math.abs(diff) / 86400)} d`
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC (${diff >= 0 ? `in ${rel}` : `${rel} ago`})`
}
