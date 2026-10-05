import type { Address } from 'viem'
import { getAddress, isAddress, parseUnits } from 'viem'

export const DEMAND_DAILY_CAP = 12_000_000n
export const DEMAND_INTERVAL_SECONDS = 90 * 60
export const DEMAND_TOKEN_DECIMALS = 6
export const DEMAND_COLLECTION_SECONDS = 20 * 60
export const DEMAND_QUOTE_MARGIN_SECONDS = 10 * 60

export function demandQuoteWindow(now: number) {
  return { quoteCollectionEndsAt: now + DEMAND_COLLECTION_SECONDS, quoteDeadline: now + DEMAND_COLLECTION_SECONDS + DEMAND_QUOTE_MARGIN_SECONDS }
}

export function demandQuotePhase(collectionEndsAt: number, quoteDeadline: number, now: number): 'collect' | 'pick' | 'expired' {
  if (now >= quoteDeadline) return 'expired'
  return now < collectionEndsAt ? 'collect' : 'pick'
}

/** Recheck at dispatch, after slow quote/registry/balance reads have finished. */
export async function pickDemandQuoteBeforeDeadline<T>(quoteDeadline: number, pick: () => Promise<T>, now = () => Math.floor(Date.now() / 1000)): Promise<T | undefined> {
  if (now() >= quoteDeadline) return undefined
  return pick()
}

export type DemandKind = 'image' | 'code'

export interface DemandTemplate {
  readonly kind: DemandKind
  readonly title: string
  readonly brief: string
  readonly acceptanceCriteria: readonly string[]
  readonly deliverable: { readonly accepts: readonly ['artifact'] | readonly ['git']; readonly target?: string }
  readonly requiredChecks: readonly string[]
}

export const DEMAND_TEMPLATES: readonly [DemandTemplate, DemandTemplate] = [
  {
    kind: 'image',
    title: 'Public-safe geometric test image',
    brief: 'Create a small public-safe geometric test image: a clean abstract composition of circles, rectangles and two contrasting colours. No people, brands, logos, text, politics, medical content or unsafe material.',
    acceptanceCriteria: ['The deliverable is a PNG or JPEG artifact.', 'The artifact is publicly fetchable and its SHA-256 hash matches the descriptor.', 'The image contains no people, brands, logos or unsafe material.'],
    deliverable: { accepts: ['artifact'] },
    requiredChecks: [],
  },
  {
    kind: 'code',
    title: 'Small deterministic parser template',
    brief: 'Add a small dependency-free TypeScript parser utility and focused tests to the public hireling-demo-deliveries repository. Work on a new branch; do not change main or add secrets. The utility should parse a line of key=value pairs deterministically and reject malformed input.',
    acceptanceCriteria: ['The deliverable is a commit in the exact public repository.', 'The commit is immutable and has a completed successful GitHub Actions check named test.', 'The utility and its tests are small, deterministic and dependency-free.'],
    deliverable: { accepts: ['git'], target: 'https://github.com/grmkris/hireling-demo-deliveries' },
    requiredChecks: ['test'],
  },
]

export interface DemandQuote {
  readonly quoteId: string
  readonly worker: string
  readonly agentId: string
  readonly token: string
  readonly symbol: string
  readonly amount: string
  readonly quoteHash: string
  readonly note?: string
}

export interface DailySpend {
  committed: Record<string, bigint>
  reserved: Record<string, bigint>
  reservations: Record<string, { amount: bigint; days: string[] }>
}

export function utcDay(timestampSeconds: number): string {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) throw new Error('timestamp must be a non-negative integer')
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10)
}

export function templateForSequence(sequence: number): DemandTemplate {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('sequence must be a non-negative integer')
  return DEMAND_TEMPLATES[sequence % DEMAND_TEMPLATES.length]!
}

export function parseMUsdAmount(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) throw new Error('quote amount must be a non-negative mUSD decimal')
  const amount = parseUnits(value, DEMAND_TOKEN_DECIMALS)
  if (amount <= 0n) throw new Error('quote amount must be positive')
  return amount
}

export function createDailySpend(): DailySpend {
  return { committed: {}, reserved: {}, reservations: {} }
}

function add(map: Record<string, bigint>, day: string, amount: bigint) {
  map[day] = (map[day] ?? 0n) + amount
}

/** Carry every unresolved reservation into a new UTC day before accepting new demand. */
export function carryReservations(spend: DailySpend, day: string): DailySpend {
  for (const saved of Object.values(spend.reservations)) {
    if (!saved.days.includes(day)) {
      saved.days.push(day)
      add(spend.reserved, day, saved.amount)
    }
  }
  return spend
}

/** Reserve exactly once. A retry with another amount is refused. */
export function reserveSpend(spend: DailySpend, day: string, operationId: string, amount: bigint): DailySpend {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('invalid UTC day')
  if (amount <= 0n || amount > DEMAND_DAILY_CAP) throw new Error('spend exceeds the daily cap')
  const prior = spend.reservations[operationId]
  if (prior !== undefined) {
    if (prior.amount !== amount) throw new Error('operation amount differs from its saved reservation')
    return spend
  }
  const used = (spend.committed[day] ?? 0n) + (spend.reserved[day] ?? 0n)
  if (used + amount > DEMAND_DAILY_CAP) throw new Error('daily demand cap reached')
  spend.reservations[operationId] = { amount, days: [day] }
  add(spend.reserved, day, amount)
  return spend
}

/** Replace reservations with the actual receipt day. Refunds never reopen the cap. */
export function commitSpend(spend: DailySpend, operationId: string, receiptDay: string): bigint {
  const prior = spend.reservations[operationId]
  if (prior === undefined) throw new Error('cannot commit an unreserved operation')
  for (const day of prior.days) {
    spend.reserved[day] = (spend.reserved[day] ?? 0n) - prior.amount
    if (spend.reserved[day] === 0n) delete spend.reserved[day]
  }
  add(spend.committed, receiptDay, prior.amount)
  delete spend.reservations[operationId]
  return prior.amount
}

/** Only a reconciled operation with no economic effect may release its reservation. */
export function releaseSpend(spend: DailySpend, operationId: string): bigint {
  const prior = spend.reservations[operationId]
  if (prior === undefined) return 0n
  for (const day of prior.days) {
    if ((spend.reserved[day] ?? 0n) < prior.amount) throw new Error('reservation accounting differs')
  }
  for (const day of prior.days) {
    const remaining = spend.reserved[day]! - prior.amount
    if (remaining === 0n) delete spend.reserved[day]
    else spend.reserved[day] = remaining
  }
  delete spend.reservations[operationId]
  return prior.amount
}

export function chooseCheapestQuote(quotes: readonly DemandQuote[], token: Address, validWorker: (quote: DemandQuote) => boolean): DemandQuote {
  const wanted = getAddress(token)
  const candidates = quotes.filter((quote) => {
    if (!isAddress(quote.worker) || !isAddress(quote.token)) return false
    if (getAddress(quote.token) !== wanted || quote.symbol !== 'mUSD') return false
    try { parseMUsdAmount(quote.amount) } catch { return false }
    return validWorker(quote)
  })
  if (candidates.length === 0) throw new Error('no valid mUSD quote is available')
  return candidates.toSorted((a, b) => {
    const difference = parseMUsdAmount(a.amount) - parseMUsdAmount(b.amount)
    return difference < 0n ? -1 : difference > 0n ? 1 : a.quoteId.localeCompare(b.quoteId)
  })[0]!
}

export function normalizeAddress(value: string): Address {
  if (!isAddress(value)) throw new Error('invalid address')
  return getAddress(value)
}

export function isImmutableSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
}
