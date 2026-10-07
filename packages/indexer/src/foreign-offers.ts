/** Content-addressed offer discovery. Call hydration only while holding the chain's indexing lease. */
import { canonicalJson, parseTerms, termsHash, type OfferTerms } from '@sidequest/board'
import { type AsyncSql, stmt } from './store.ts'

type JsonTerms<T> = T extends bigint
  ? string
  : T extends readonly (infer E)[]
    ? readonly JsonTerms<E>[]
    : T extends object
      ? { [K in keyof T]: JsonTerms<T[K]> }
      : T
export type FrozenOfferTerms = JsonTerms<OfferTerms>
export interface ForeignOffer {
  readonly termsHash: string
  readonly origin: string
  readonly terms: FrozenOfferTerms
}

export interface OfferHydrationConfig {
  readonly boards: readonly string[]
  readonly origin: string
  readonly fetch?: typeof fetch
  readonly maxFetches?: number
  readonly timeoutMs?: number
  readonly retrySeconds?: number
}

export const MAX_OFFER_FETCHES = 8
const MAX_OFFER_BYTES = 1024 * 1024

/** Published manifests are distinct from evidence policy hashes. Older projections read the original event. */
export const OFFER_HASH_SQL = `COALESCE(j.manifest_hash, (SELECT json_extract(p.args_json, '$.manifestHash') FROM events p
  WHERE p.chain_id = j.chain_id AND p.job_id = j.job_id AND p.name = 'Published' ORDER BY p.block, p.log_index LIMIT 1), j.policy_hash)`

const isString = (value: unknown): value is string => typeof value === 'string'

function displayable(terms: OfferTerms): terms is OfferTerms {
  return (
    terms.v === 2 &&
    terms.mode === 'hire' &&
    typeof terms.title === 'string' &&
    typeof terms.brief === 'string' &&
    Array.isArray(terms.acceptanceCriteria) &&
    terms.acceptanceCriteria.every(isString) &&
    terms.windows != null &&
    [terms.windows.reviewSeconds, terms.windows.disputeSeconds, terms.windows.arbitrationSeconds].every(
      Number.isSafeInteger,
    ) &&
    (terms.tags === undefined || (Array.isArray(terms.tags) && terms.tags.every(isString)))
  )
}

/** Hash canonical frozen terms with the board's implementation; a host's hash claim is never trusted. */
export function verifyForeignOffer(body: string, hash: string): FrozenOfferTerms | undefined {
  try {
    const terms = parseTerms(body)
    if (!displayable(terms) || termsHash(terms).toLowerCase() !== hash.toLowerCase()) return undefined
    // SAFETY: canonicalJson serializes these parsed and hash-verified terms, replacing every bigint with a string.
    return JSON.parse(canonicalJson(terms)) as FrozenOfferTerms
  } catch {
    return undefined
  }
}

export function foreignOfferOf(row: { terms_hash: string; origin: string; body: string }): ForeignOffer {
  // SAFETY: foreign_offers bodies enter the cache only after verifyForeignOffer succeeds.
  return { termsHash: row.terms_hash, origin: row.origin, terms: JSON.parse(row.body) as FrozenOfferTerms }
}

export async function foreignOffer(sql: AsyncSql, hash: string): Promise<ForeignOffer | null> {
  const [row] = await sql.all<{ terms_hash: string; origin: string; body: string }>(
    'SELECT * FROM foreign_offers WHERE terms_hash = ?',
    hash.toLowerCase(),
  )
  return row === undefined ? null : foreignOfferOf(row)
}

export async function offerHashForJob(sql: AsyncSql, chainId: number, jobId: string): Promise<string | null> {
  const [row] = await sql.all<{ terms_hash: string | null }>(
    `SELECT lower(${OFFER_HASH_SQL}) AS terms_hash FROM jobs j WHERE j.chain_id = ? AND j.job_id = ?`,
    chainId,
    jobId,
  )
  return row?.terms_hash ?? null
}

/** Enrich reads without changing notification recipients, summaries, cursors or next actions. */
export async function foreignOffersForJobs(
  sql: AsyncSql,
  chainId: number,
  ids: readonly (string | null)[],
): Promise<Map<string | null, ForeignOffer>> {
  const out = new Map<string | null, ForeignOffer>()
  const jobs = [...new Set(ids.filter((id): id is string => id !== null))]
  if (jobs.length === 0) return out
  const [cache] = await sql.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'foreign_offers'",
  )
  if (cache === undefined) return out
  const [local] = await sql.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'board_offers'",
  )
  for (let i = 0; i < jobs.length; i += 90) {
    const page = jobs.slice(i, i + 90)
    const rows = await sql.all<{ job_id: string; terms_hash: string; origin: string; body: string }>(
      `SELECT j.job_id, f.* FROM jobs j
      JOIN foreign_offers f ON f.terms_hash = lower(${OFFER_HASH_SQL})
      WHERE j.chain_id = ? AND j.job_id IN (${page.map(() => '?').join(',')})
      ${local === undefined ? '' : `AND NOT EXISTS (SELECT 1 FROM board_offers o WHERE o.terms_hash = f.terms_hash)`}`,
      chainId,
      ...page,
    )
    for (const row of rows) out.set(row.job_id, foreignOfferOf(row))
  }
  return out
}

async function boundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('Offer has no body')
  const bytes = new Uint8Array(MAX_OFFER_BYTES)
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (size + chunk.value.byteLength > MAX_OFFER_BYTES) throw new Error('Offer too large')
      bytes.set(chunk.value, size)
      size += chunk.value.byteLength
    }
  } finally {
    await reader.cancel()
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
}

async function loadOffer(host: string, hash: string, cfg: OfferHydrationConfig): Promise<string | undefined> {
  try {
    const response = await (cfg.fetch ?? fetch)(`${host}/offers/${hash}.json`, {
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 2500),
      // Workers reject redirect: 'error'. A redirect comes back as a 3xx, which is not ok, so it is never followed.
      redirect: 'manual',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    const terms = verifyForeignOffer(await boundedBody(response), hash)
    return terms === undefined ? undefined : canonicalJson(terms)
  } catch {
    return undefined
  }
}

/** Only allowlisted HTTPS origins are contacted, never redirects or URLs supplied in an offer. */
function knownHosts(cfg: OfferHydrationConfig): string[] {
  return [...new Set(cfg.boards)].filter((origin) => {
    try {
      const url = new URL(origin)
      return (
        url.protocol === 'https:' &&
        url.origin === origin &&
        url.username === '' &&
        url.password === '' &&
        url.origin !== new URL(cfg.origin).origin
      )
    } catch {
      return false
    }
  })
}

async function candidates(sql: AsyncSql, chainId: number, hosts: readonly string[], now: number) {
  const [local] = await sql.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'board_offers'",
  )
  return sql.all<{ terms_hash: string }>(
    `SELECT DISTINCT lower(${OFFER_HASH_SQL}) AS terms_hash FROM jobs j
    WHERE j.chain_id = ? AND j.kind = 'sidequest-v1' AND ${OFFER_HASH_SQL} IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM foreign_offers f WHERE f.terms_hash = lower(${OFFER_HASH_SQL}))
    ${local === undefined ? '' : `AND NOT EXISTS (SELECT 1 FROM board_offers o WHERE o.terms_hash = lower(${OFFER_HASH_SQL}))`}
    AND EXISTS (SELECT 1 FROM json_each(?) h WHERE NOT EXISTS (SELECT 1 FROM foreign_offer_misses m WHERE m.terms_hash = lower(${OFFER_HASH_SQL}) AND m.origin = h.value AND m.retry_after > ?))
    ORDER BY j.published_block DESC LIMIT 100`,
    chainId,
    JSON.stringify(hosts),
    now,
  )
}

interface FetchBudget {
  used: number
  attempts: number
  stored: number
  start: number
  limit: number
}

async function hydrateHash(
  sql: AsyncSql,
  input: { chainId: number; hash: string; hosts: readonly string[]; now: number },
  cfg: OfferHydrationConfig,
  budget: FetchBudget,
): Promise<void> {
  for (const host of input.hosts) {
    if (budget.attempts >= budget.limit || budget.used >= budget.limit) return
    const [miss] = await sql.all<{ retry_after: number }>(
      'SELECT retry_after FROM foreign_offer_misses WHERE terms_hash = ? AND origin = ?',
      input.hash,
      host,
    )
    if (miss !== undefined && miss.retry_after > input.now) continue
    budget.used++
    budget.attempts++
    // Claim before network I/O so crashes and timeouts also consume the minute's allowance.
    await sql.batch([
      stmt('INSERT OR REPLACE INTO foreign_offer_budget VALUES (?, ?, ?)', input.chainId, budget.start, budget.used),
    ])
    const body = await loadOffer(host, input.hash, cfg)
    if (body !== undefined) {
      await sql.batch([
        stmt('INSERT OR IGNORE INTO foreign_offers VALUES (?, ?, ?, ?)', input.hash, host, body, input.now),
      ])
      budget.stored++
      return
    }
    await sql.batch([
      stmt(
        'INSERT OR REPLACE INTO foreign_offer_misses VALUES (?, ?, ?)',
        input.hash,
        host,
        input.now + (cfg.retrySeconds ?? 3600),
      ),
    ])
  }
}

/** Persistent minute budget counts HTTP attempts, including failures, across restarts and repeated cron runs. */
export async function hydrateForeignOffers(sql: AsyncSql, chainId: number, cfg: OfferHydrationConfig, now: number) {
  const hosts = knownHosts(cfg)
  const limit = Math.min(MAX_OFFER_FETCHES, Math.max(0, Math.floor(cfg.maxFetches ?? MAX_OFFER_FETCHES)))
  if (hosts.length === 0 || limit === 0) return { attempts: 0, stored: 0 }
  const [saved] = await sql.all<{ window_start: number; attempts: number }>(
    'SELECT * FROM foreign_offer_budget WHERE chain_id = ?',
    chainId,
  )
  const start = saved !== undefined && now < saved.window_start + 60 ? saved.window_start : now
  const budget: FetchBudget = {
    used: start === saved?.window_start ? saved.attempts : 0,
    attempts: 0,
    stored: 0,
    start,
    limit,
  }
  for (const { terms_hash: hash } of await candidates(sql, chainId, hosts, now)) {
    if (budget.used >= limit || budget.attempts >= limit) break
    if (!/^0x[0-9a-f]{64}$/.test(hash)) continue
    await hydrateHash(sql, { chainId, hash, hosts, now }, cfg, budget)
  }
  return { attempts: budget.attempts, stored: budget.stored }
}
