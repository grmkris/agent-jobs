import { formatUnits } from 'viem'
import type { AdvanceBudgetTerms, CallBudgetTerms } from './api.ts'
import { deployment, isMainnet } from './wallet.ts'

export interface TokenMeta {
  symbol: string
  decimals: number
}

/**
 * Reward tokens by address. The deployment's own are known up front (Circle USDC on mainnet; mUSD and mEUR on
 * testnet); every board's allowed tokens (with the symbol and decimals the board read from the chain) are added by
 * `registerTokens` once `/data/boards` answers, so a token like $CHOMP never shows as "token".
 */
export const TOKENS: Record<string, TokenMeta> = isMainnet
  ? {
      [deployment.rewardTokens[0]?.toLowerCase() ?? '']: { symbol: 'USDC', decimals: 6 },
      [deployment.factory.toLowerCase()]: { symbol: 'FACTORY', decimals: 18 },
    }
  : {
      [deployment.rewardTokens[0]?.toLowerCase() ?? '']: { symbol: 'mUSD', decimals: 6 },
      [deployment.rewardTokens[1]?.toLowerCase() ?? '']: { symbol: 'mEUR', decimals: 6 },
      [deployment.factory.toLowerCase()]: { symbol: 'FACTORY', decimals: 18 },
    }

export function registerTokens(tokens: ReadonlyArray<{ address: string; symbol: string; decimals: number }>): void {
  for (const t of tokens) TOKENS[t.address.toLowerCase()] ??= { symbol: t.symbol, decimals: t.decimals }
}

/** The reward tokens a publish may offer: every known token but the bond token. */
export const rewardTokenList = () => Object.entries(TOKENS).filter(([a]) => a !== deployment.factory.toLowerCase() && a !== '')

export function tokenInfo(address: string | null | undefined): TokenMeta {
  const a = (address ?? '').toLowerCase()
  return TOKENS[a] ?? { symbol: 'tokens', decimals: 18 }
}

/** Base units as people read them: grouped thousands, at most 4 decimals, trailing zeros dropped. */
export function formatNumber(value: bigint, decimals: number): string {
  const [whole = '0', frac = ''] = formatUnits(value, decimals).split('.')
  const grouped = BigInt(whole).toLocaleString('en-US')
  const f = frac.slice(0, 4).replace(/0+$/, '')
  return f === '' ? grouped : `${grouped}.${f}`
}

/** "7 mUSD". Testnet's "test tokens, no real value" is said once, on the network pill, not after every amount. */
export function amount(value: string | null | undefined, token: string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  const t = tokenInfo(token)
  return `${formatNumber(BigInt(value), t.decimals)} ${t.symbol}`
}

/** An execution budget's cap as people read it; a call budget names the function and contract it may call once. */
export function budgetCap(eb: AdvanceBudgetTerms | CallBudgetTerms): string {
  if (eb.kind === 'advance') return amount(eb.cap, eb.token)
  const name = /function\s+(\w+)/.exec(eb.function ?? '')?.[1] ?? 'call'
  return `${formatNumber(BigInt(eb.cap), 18)} MON for ${name}() on ${eb.target.slice(0, 8)}…${eb.target.slice(-4)}`
}

export const bond = (value: string | null | undefined) => (value === null || value === undefined ? '—' : `${formatNumber(BigInt(value), 18)} FACTORY`)

/** "3 h 5 min", "2 d 4 h", "40 s": a span of seconds at two units of precision. */
export function span(seconds: number): string {
  const a = Math.abs(Math.round(seconds))
  const d = Math.floor(a / 86_400)
  const h = Math.floor((a % 86_400) / 3600)
  const m = Math.floor((a % 3600) / 60)
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`
  if (h > 0) return m > 0 && h < 6 ? `${h} h ${m} min` : `${h} h`
  if (m > 0) return `${m} min`
  return `${a} s`
}

/** "in 3 h", "2 d ago" relative to `now` (unix seconds). */
export const relative = (unix: number, now = Date.now() / 1000) => (unix >= now ? `in ${span(unix - now)}` : `${span(now - unix)} ago`)

/** A moment in the reader's own time zone: "Thu 1 Oct, 14:29". */
export function localTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** "Thu 1 Oct, 14:29 (in 2 h)", in the reader's time zone; the exact UTC instant is in `<When>`'s tooltip. */
export function when(unix: number | null | undefined): string {
  if (unix === null || unix === undefined || unix === 0) return '—'
  return `${localTime(unix)} (${relative(unix)})`
}
