import { isIP } from 'node:net'
import { errorDiagnostics } from '@sidequest/board'
import { type AsyncSql, stmt } from './store.ts'
import type { Network } from '@sidequest/sdk'
import { cursorOf } from './feed.ts'
import { eventArguments, eventCursor, eventMaxAge, eventPage, eventStart } from './mcp-events.ts'
import { telegramChainId } from './telegram.ts'

export class EventRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'EventRpcError' }
}
export type WebhookFetch = typeof fetch
export const WEBHOOK_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS event_subscriptions (
    id TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    args_json TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    cursor_seq INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'failing', 'terminated')),
    refresh_before INTEGER NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS event_subscriptions_due ON event_subscriptions (status, next_attempt_at, refresh_before)',
  // A principal whose hosted access stopped. Its subscriptions are terminated and none can be created or delivered again.
  'CREATE TABLE IF NOT EXISTS event_revoked_principals (principal TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS event_subscription_grants (subscription_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS event_revoked_grants (grant_id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL)',
] as const
const NOT_REVOKED = `NOT EXISTS (SELECT 1 FROM event_revoked_principals r WHERE r.principal = event_subscriptions.principal)
  AND NOT EXISTS (SELECT 1 FROM event_subscription_grants g JOIN event_revoked_grants r ON r.grant_id = g.grant_id WHERE g.subscription_id = event_subscriptions.id)`
const revokedError = () => new EventRpcError(-32003, 'This agent\'s access is stopped')
const migrated = new WeakSet<AsyncSql>()
export async function migrateWebhooks(sql: AsyncSql): Promise<void> {
  if (migrated.has(sql)) return
  await sql.batch(WEBHOOK_SCHEMA.map(query => stmt(query)))
  migrated.add(sql)
}
const encoder = new TextEncoder()
const BODY_LIMIT = 262_144
const DAY = 86_400
/** A lease lasts at most six hours, so a disconnected client stops receiving its feed within that bound. */
const MAX_LEASE = 6 * 3600
const base64 = (bytes: ArrayBuffer) => btoa(String.fromCodePoint(...new Uint8Array(bytes)))
function rawSecret(secret: string): Uint8Array<ArrayBuffer> {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new EventRpcError(-32602, 'Invalid webhook secret')
  try {
    const bytes = Uint8Array.from(atob(secret.slice(6)), c => c.codePointAt(0) ?? 0)
    if (bytes.byteLength < 24 || bytes.byteLength > 64) throw new Error('length')
    return bytes
  } catch { throw new EventRpcError(-32602, 'Secret must encode 24 to 64 bytes') }
}
async function signature(secret: string, id: string, timestamp: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', rawSecret(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return `v1,${base64(await crypto.subtle.sign('HMAC', key, new Uint8Array([...encoder.encode(`${id}.${timestamp}.`), ...body])))}`
}
function canonical(args: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(args).toSorted().map(key => [key, args[key]])))
}
async function subscriptionId(principal: string, chain: number, url: string, name: string, args: Record<string, unknown>, grantId?: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([principal.toLowerCase(), chain, url, name, canonical(args), ...(grantId === undefined ? [] : [grantId])])))
  return `sub_${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

/** Includes mapped IPv4, so alternate spellings cannot bypass the address check. */
function publicAddress(value: string): boolean {
  const raw = value.replace(/^\[|\]$/g, '')
  if (isIP(raw) === 4) {
    const [a, b] = raw.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127))
  }
  if (isIP(raw) !== 6) return false
  const normalized = new URL(`https://[${raw}]/`).hostname.slice(1, -1)
  const [left = '', right] = normalized.split('::')
  const first = left === '' ? [] : left.split(':')
  const last = right === undefined || right === '' ? [] : right.split(':')
  const words = (right === undefined ? first : [...first, ...Array<string>(8 - first.length - last.length).fill('0'), ...last]).map(word => Number.parseInt(word, 16))
  const head = words[0]!
  if ((head & 0xfe00) === 0xfc00 || (head & 0xffc0) === 0xfe80 || (head & 0xffc0) === 0xfec0 || (head & 0xff00) === 0xff00) return false
  if (words.slice(0, 5).every(word => word === 0) && (words[5] === 0 || words[5] === 0xffff)) {
    const hi = words[6]!, lo = words[7]!
    return publicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  return true
}
function callbackUrl(raw: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new EventRpcError(-32602, 'Invalid callback URL') }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') || url.username !== '' || url.password !== '' || raw.includes('#') || /^https:\/\/[^/]*@/i.test(raw)
    || ['localhost', 'local', 'internal', 'home.arpa'].includes(host) || ['.localhost', '.local', '.internal', '.home.arpa'].some(suffix => host.endsWith(suffix))) throw new EventRpcError(-32602, 'Callback must be public HTTPS on port 443')
  return url
}
async function deadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([run(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Webhook timeout')) }, ms)
    })])
  } finally { clearTimeout(timer) }
}
async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > BODY_LIMIT) throw new Error('Response too large')
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('Response has no body')
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > BODY_LIMIT) throw new Error('Response too large')
      parts.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const body = new Uint8Array(size)
  let offset = 0
  for (const part of parts) { body.set(part, offset); offset += part.byteLength }
  return JSON.parse(new TextDecoder().decode(body)) as unknown
}
export async function assertPublicCallback(raw: string, transport: WebhookFetch = fetch): Promise<URL> {
  const url = callbackUrl(raw)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    if (!publicAddress(host)) throw new EventRpcError(-32602, 'Callback address is not public')
    return url
  }
  try {
    const answers = await Promise.all(['A', 'AAAA'].map(type => deadline(8000, async signal => {
      const response = await transport(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' }, redirect: 'manual', signal })
      if (!response.ok) throw new Error('DNS unavailable')
      const body = await boundedJson(response) as { Status?: number; Answer?: Array<{ type: number; data: string }> }
      if (body.Status !== 0 || (body.Answer !== undefined && !Array.isArray(body.Answer))) throw new Error('DNS failed')
      return (body.Answer ?? []).filter(answer => answer.type === 1 || answer.type === 28).map(answer => answer.data)
    })))
    const addresses = answers.flat()
    if (addresses.length === 0 || addresses.some(address => typeof address !== 'string' || !publicAddress(address))) throw new Error('DNS address is not public')
  } catch { throw new EventRpcError(-32602, 'Callback DNS could not be verified as public') }
  return url
}

async function deliveryHeaders(secret: string, subscription: string, id: string, now: number, body: Uint8Array): Promise<Record<string, string>> {
  if (body.byteLength > BODY_LIMIT) throw new Error('Webhook body exceeds limit')
  const timestamp = String(Math.floor(now))
  return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': await signature(secret, id, timestamp, body), 'x-mcp-subscription-id': subscription }
}
interface Subscription {
  id: string; principal: string; chain_id: number; name: string; args_json: string; url: string; secret: string; cursor_seq: number
  status: 'active' | 'failing' | 'terminated'; refresh_before: number; failures: number; next_attempt_at: number; last_error: string | null
  created_at: number; updated_at: number
}
export async function subscribeWebhook(sql: AsyncSql, network: Network, principal: string, params: Record<string, unknown>, now: number, transport: WebhookFetch = fetch, grantId?: string): Promise<Record<string, unknown>> {
  const { name, args } = eventArguments(params.name, params.arguments)
  eventCursor(params.cursor); eventMaxAge(params.maxAgeMs)
  const d = params.delivery as Record<string, unknown> | undefined
  if (d === undefined || d === null || d.mode !== 'webhook' || typeof d.url !== 'string' || typeof d.secret !== 'string') throw new EventRpcError(-32602, 'Webhook delivery with URL and secret is required')
  rawSecret(d.secret)
  const ttlMs = params.ttlMs ?? MAX_LEASE * 1000
  if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new EventRpcError(-32602, 'ttlMs must be a positive integer')
  const url = await assertPublicCallback(d.url, transport)
  const chain = telegramChainId(network)
  const id = await subscriptionId(principal, chain, url.href, name, args, grantId)
  await migrateWebhooks(sql)
  if ((await sql.all('SELECT 1 FROM event_revoked_principals WHERE principal = ?', principal.toLowerCase())).length > 0) throw revokedError()
  if (grantId !== undefined && (await sql.all('SELECT 1 FROM event_revoked_grants WHERE grant_id = ?', grantId)).length > 0) throw new EventRpcError(-32003, 'This OAuth connection was revoked')
  const [existing] = await sql.all<Subscription>('SELECT * FROM event_subscriptions WHERE id = ?', id)
  const start = existing !== undefined && existing.status !== 'terminated' ? { seq: existing.cursor_seq, truncated: false }
    : await eventStart(sql, network, principal, { ...params, name, arguments: args }, now)
  const challenge = crypto.randomUUID()
  const body = encoder.encode(JSON.stringify({ type: 'verification', challenge }))
  const headers = await deliveryHeaders(d.secret, id, `msg_verification_${crypto.randomUUID()}`, now, body)
  try {
    await deadline(5000, async signal => {
      const response = await transport(url.href, { method: 'POST', headers, body, redirect: 'manual', signal })
      if (response.status !== 200) { await response.body?.cancel(); throw new Error('Verification response status') }
      const answer = await boundedJson(response)
      if (typeof answer !== 'object' || answer === null || Object.keys(answer).length !== 1 || (answer as { challenge?: unknown }).challenge !== challenge) throw new Error('Verification challenge mismatch')
    })
  } catch { throw new EventRpcError(-32015, 'Webhook verification failed') }
  // A longer request is shortened, not refused: refreshBefore tells the client when to subscribe again.
  const refreshBefore = now + Math.max(1, Math.floor(Math.min(ttlMs, MAX_LEASE * 1000) / 1000))
  // Refresh cannot rewind an in-flight cursor or erase the beginning of continuous delivery failure. The write is
  // conditional on the principal not being revoked in the same statement, so a subscribe that was in flight when
  // access stopped cannot land after the termination (VV2-030).
  await sql.batch([stmt(`INSERT INTO event_subscriptions (id, principal, chain_id, name, args_json, url, secret, cursor_seq, status, refresh_before, failures, next_attempt_at, last_error, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, NULL, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM event_revoked_principals WHERE principal = ?)
      AND NOT EXISTS (SELECT 1 FROM event_revoked_grants WHERE grant_id = ?)
    ON CONFLICT(id) DO UPDATE SET secret = excluded.secret, refresh_before = excluded.refresh_before,
    cursor_seq = CASE WHEN status = 'terminated' THEN excluded.cursor_seq ELSE cursor_seq END,
    failures = CASE WHEN status = 'terminated' THEN 0 ELSE failures END,
    next_attempt_at = CASE WHEN status = 'failing' THEN next_attempt_at ELSE excluded.next_attempt_at END,
    last_error = CASE WHEN status = 'failing' THEN last_error ELSE NULL END,
    updated_at = CASE WHEN status = 'failing' THEN updated_at ELSE excluded.updated_at END,
    status = CASE WHEN status = 'failing' THEN status ELSE 'active' END`,
  id, principal.toLowerCase(), chain, name, canonical(args), url.href, d.secret, start.seq, refreshBefore, now, now, now, principal.toLowerCase(), grantId ?? ''),
  ...(grantId === undefined ? [] : [stmt('INSERT OR IGNORE INTO event_subscription_grants (subscription_id, grant_id) VALUES (?, ?)', id, grantId)])])
  const [saved] = await sql.all<Subscription>(`SELECT * FROM event_subscriptions WHERE id = ? AND status <> 'terminated' AND ${NOT_REVOKED}`, id)
  if (saved === undefined) throw revokedError()
  return { id, refreshBefore: new Date(refreshBefore * 1000).toISOString(), cursor: cursorOf(saved.cursor_seq), truncated: start.truncated,
    deliveryStatus: { active: saved.status === 'active', ...(saved.last_error === null ? {} : { lastError: saved.last_error }) } }
}
export async function unsubscribeWebhook(sql: AsyncSql, network: Network, principal: string, params: Record<string, unknown>, now: number, grantId?: string): Promise<Record<string, unknown>> {
  let id = params.id
  if (id === undefined) {
    // Purrable's current client uses this selector form rather than the profile's id form.
    const { name, args } = eventArguments(params.name, params.arguments)
    const d = params.delivery as Record<string, unknown> | undefined
    if (d?.mode !== 'webhook' || typeof d.url !== 'string') throw new EventRpcError(-32602, 'Subscription id or webhook selector is required')
    id = await subscriptionId(principal, telegramChainId(network), callbackUrl(d.url).href, name, args, grantId)
  }
  if (typeof id !== 'string' || id.length === 0) throw new EventRpcError(-32602, 'Subscription id is required')
  await migrateWebhooks(sql)
  await sql.batch([stmt("UPDATE event_subscriptions SET status = 'terminated', updated_at = ? WHERE id = ? AND principal = ? AND chain_id = ? AND (? = '' OR id IN (SELECT subscription_id FROM event_subscription_grants WHERE grant_id = ?))", now, id, principal.toLowerCase(), telegramChainId(network), grantId ?? '', grantId ?? '')])
  return {}
}
export function reportWebhookFailure(error: unknown): void { console.error(JSON.stringify({ event: 'webhook-failed', ...errorDiagnostics(error) })) }
const backoff = (failures: number) => [60, 120, 300, 900, 3600][Math.min(failures - 1, 4)]!

/** Seconds, like the feed. During failure updated_at anchors the continuous failure interval. */
export async function deliverWebhooks(sql: AsyncSql, network: Network, now: number, options: { fetch?: WebhookFetch; budget?: number } = {}): Promise<{ posts: number; subscriptions: number }> {
  await migrateWebhooks(sql)
  await sql.batch([
    stmt('DELETE FROM event_subscriptions WHERE refresh_before <= ?', now - 7 * DAY),
    stmt(`UPDATE event_subscriptions SET status = 'terminated', last_error = 'Agent access stopped', updated_at = ? WHERE status <> 'terminated' AND NOT (${NOT_REVOKED})`, now),
  ])
  const rows = await sql.all<Subscription>(`SELECT * FROM event_subscriptions WHERE chain_id = ? AND status IN ('active', 'failing') AND next_attempt_at <= ? AND refresh_before > ? AND ${NOT_REVOKED} ORDER BY next_attempt_at, created_at, id`, telegramChainId(network), now, now)
  const transport = options.fetch ?? fetch
  const budget = Math.min(100, Math.max(0, Math.floor(options.budget ?? 100)))
  let posts = 0, subscriptions = 0, next = 0
  const work = async (row: Subscription) => {
    subscriptions++
    const current = async () => (await sql.all<{ id: string }>(`SELECT id FROM event_subscriptions WHERE id = ? AND secret = ? AND status IN ('active', 'failing') AND refresh_before > ? AND ${NOT_REVOKED}`, row.id, row.secret, now)).length > 0
    const terminate = async (reason: string) => sql.batch([stmt("UPDATE event_subscriptions SET status = 'terminated', last_error = ?, updated_at = ? WHERE id = ? AND secret = ? AND status IN ('active', 'failing')", reason, now, row.id, row.secret)])
    const send = async (envelope: unknown, id: string): Promise<number | undefined> => {
      const body = encoder.encode(JSON.stringify(envelope))
      const headers = await deliveryHeaders(row.secret, row.id, id, now, body)
      if (posts >= budget || !await current()) return undefined
      // Reserve synchronously after the awaited state check; six workers share this strict POST budget.
      if (posts >= budget) return undefined
      posts++
      return deadline(8000, async signal => {
        const response = await transport(row.url, { method: 'POST', headers, body, redirect: 'manual', signal })
        await response.body?.cancel()
        return response.status
      })
    }
    const accept = async (status: number | undefined): Promise<boolean> => {
      if (status === undefined) return false
      if (status === 410 || status === 413) { await terminate(`HTTP ${status}`); return false }
      if (status < 200 || status >= 300) throw new EventRpcError(-32015, `HTTP ${status}`)
      return true
    }
    const advance = async (seq: number) => {
      await sql.batch([stmt("UPDATE event_subscriptions SET cursor_seq = ?, status = 'active', failures = 0, next_attempt_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND secret = ? AND status IN ('active', 'failing')", seq, now, now, row.id, row.secret)])
      row.cursor_seq = seq; row.status = 'active'; row.failures = 0; row.updated_at = now
    }
    try {
      if (!await current()) return
      if (row.status === 'failing' && now - row.updated_at >= DAY) {
        try {
          await assertPublicCallback(row.url, transport)
          await send({ type: 'terminated', error: { code: -32015, message: 'Delivery failed continuously for 24 hours' } }, `msg_terminated_${crypto.randomUUID()}`)
        } catch { /* Best effort; retirement does not depend on the receiver. */ }
        await terminate('Delivery failed continuously for 24 hours')
        return
      }
      const page = await eventPage(sql, network, row.principal, { name: row.name, arguments: JSON.parse(row.args_json) as unknown, cursor: cursorOf(row.cursor_seq) }, now, 20)
      if (page.gap || page.events.length > 0) await assertPublicCallback(row.url, transport)
      if (page.gap) {
        const [oldest] = await sql.all<{ seq: number }>('SELECT min(seq) AS seq FROM feed_events WHERE chain_id = ?', row.chain_id)
        const seq = oldest!.seq
        if (!await accept(await send({ type: 'gap', cursor: cursorOf(seq) }, `msg_gap_${crypto.randomUUID()}`))) return
        await advance(seq - 1)
      }
      for (const event of page.events) {
        if (!await accept(await send(event, event.eventId))) return
        await advance(eventCursor(event.cursor)!)
      }
      await sql.batch([stmt("UPDATE event_subscriptions SET next_attempt_at = ? WHERE id = ? AND secret = ? AND status IN ('active', 'failing')", page.hasMore ? now : now + 60, row.id, row.secret)])
    } catch (error) {
      // Keep response bodies, URLs, secrets and arbitrary thrown messages out of both logs and persisted errors.
      reportWebhookFailure(error)
      const reason = error instanceof EventRpcError && /^HTTP \d{3}$/.test(error.message) ? error.message : 'Webhook delivery failed'
      await sql.batch([stmt("UPDATE event_subscriptions SET status = 'failing', failures = failures + 1, next_attempt_at = ?, last_error = ?, updated_at = CASE WHEN status = 'failing' THEN updated_at ELSE ? END WHERE id = ? AND secret = ? AND status IN ('active', 'failing')", now + backoff(row.failures + 1), reason, now, row.id, row.secret)])
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, rows.length) }, async () => {
    while (next < rows.length) {
      if (posts >= budget) break
      const row = rows[next++]!
      await work(row).catch(reportWebhookFailure)
    }
  }))
  return { posts, subscriptions }
}
/** Records the principal as revoked and terminates its subscriptions in one batch. Idempotent. */
export async function terminateSubscriptions(sql: AsyncSql, principal: string, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await migrateWebhooks(sql)
  await sql.batch([
    stmt('INSERT OR IGNORE INTO event_revoked_principals (principal, revoked_at) VALUES (?, ?)', principal.toLowerCase(), now),
    stmt("UPDATE event_subscriptions SET status = 'terminated', last_error = 'Agent access stopped', updated_at = ? WHERE principal = ? AND status <> 'terminated'", now, principal.toLowerCase()),
  ])
}

/** Disconnect only this OAuth family. A fresh consent may subscribe again; an in-flight revoked grant cannot. */
export async function terminateGrantSubscriptions(sql: AsyncSql, principal: string, grantId: string, now: number): Promise<void> {
  await migrateWebhooks(sql)
  await sql.batch([
    stmt('INSERT OR IGNORE INTO event_revoked_grants (grant_id, revoked_at) VALUES (?, ?)', grantId, now),
    stmt(`UPDATE event_subscriptions SET status = 'terminated', last_error = 'OAuth connection revoked', updated_at = ?
      WHERE principal = ? AND status <> 'terminated' AND
      (id IN (SELECT subscription_id FROM event_subscription_grants WHERE grant_id = ?) OR NOT EXISTS (SELECT 1 FROM event_subscription_grants g WHERE g.subscription_id = event_subscriptions.id))`, now, principal.toLowerCase(), grantId),
  ])
}
