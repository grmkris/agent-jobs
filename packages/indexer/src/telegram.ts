/** Wallet signatures authorize notification links only; Telegram never gains authority over funds. */
import type { Address, Hex } from 'viem'
import { isAddress } from 'viem'
import type { Network } from '@sidequest/sdk'
import { stageProfile } from '../../../infra/stage.ts'
import { type AsyncSql, type Statement, stmt } from './store.ts'

/** D9: release configuration, not Worker bindings. Kris supplies the real public handles. */
const PUBLIC_CHANNEL_BY_NETWORK: Record<Network, string> = { 'monad-testnet': '', 'monad-mainnet': '' }
export const telegramPublicChannel = (network: Network): string => PUBLIC_CHANNEL_BY_NETWORK[network]
/** Release configuration: wallets whose linked Telegram chats receive operator alerts (relay balance). Kris links once at /telegram. */
const OWNER_WALLETS_BY_NETWORK: Record<Network, readonly string[]> = {
  'monad-testnet': ['0xB9970A6371358F6C74DFb15A7cB2653E3AE3E471'],
  'monad-mainnet': ['0xB9970A6371358F6C74DFb15A7cB2653E3AE3E471'],
}
export const telegramOwnerWallets = (network: Network): readonly string[] => OWNER_WALLETS_BY_NETWORK[network]
let siteOrigin: string | undefined
let botUsername: string | undefined
/** Worker/DO startup sets its canonical stage bindings once for all notification/feed producers. */
export function configurePublicSite(origin: string, bot: string): void {
  siteOrigin = new URL(origin).origin
  if (bot !== '' && !/^[A-Za-z0-9_]+$/.test(bot)) throw new Error('Invalid Telegram bot username')
  botUsername = bot
}
export const telegramBot = (_network: Network): string => botUsername ?? stageProfile()?.telegram.botUsername ?? stageProfile('dev')!.telegram.botUsername
export const publicOrigin = (): string => siteOrigin ?? stageProfile()?.origin ?? stageProfile('dev')!.origin
export const telegramChainId = (network: Network) => network === 'monad-mainnet' ? 143 : 10143
const chainIdOf = telegramChainId

export class TelegramError extends Error {
  constructor(readonly code: 'invalid' | 'forbidden' | 'unavailable', message: string) { super(message) }
}

export interface TelegramTransport {
  sendMessage(chatId: string, text: string): Promise<{ messageId: number }>
}

export const TELEGRAM_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS telegram_links (
    chat_id TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, wallet TEXT NOT NULL UNIQUE, username TEXT, linked_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS telegram_challenges (
    wallet TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, nonce TEXT NOT NULL UNIQUE, message TEXT NOT NULL,
    expires_at INTEGER NOT NULL, confirmed_at INTEGER, consumed_at INTEGER, consume_token TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS telegram_updates (
    id TEXT PRIMARY KEY, claim_token TEXT NOT NULL, received_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS telegram_outbox (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, wallet TEXT, text TEXT NOT NULL, status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER,
    last_error TEXT, telegram_message_id INTEGER, created_at INTEGER NOT NULL, sent_at INTEGER,
    guard_chain_id INTEGER, guard_job_id TEXT, guard_until INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS telegram_outbox_ready ON telegram_outbox (status, due_at)',
  `CREATE TABLE IF NOT EXISTS telegram_notified_events (id TEXT PRIMARY KEY, processed_at INTEGER NOT NULL)`,
] as const

export async function migrateTelegram(sql: AsyncSql): Promise<void> {
  await sql.batch(TELEGRAM_SCHEMA.map((q) => stmt(q)))
  const columns = new Set((await sql.all<{ name: string }>('PRAGMA table_info(telegram_outbox)')).map((c) => c.name))
  const missing: Statement[] = []
  if (!columns.has('guard_chain_id')) missing.push(stmt('ALTER TABLE telegram_outbox ADD COLUMN guard_chain_id INTEGER'))
  if (!columns.has('guard_job_id')) missing.push(stmt('ALTER TABLE telegram_outbox ADD COLUMN guard_job_id TEXT'))
  if (!columns.has('guard_until')) missing.push(stmt('ALTER TABLE telegram_outbox ADD COLUMN guard_until INTEGER'))
  if (missing.length > 0) {
    try { await sql.batch(missing) } catch {
      const after = new Set((await sql.all<{ name: string }>('PRAGMA table_info(telegram_outbox)')).map((c) => c.name))
      if (missing.some((s) => !after.has(s.query.match(/ADD COLUMN (\w+)/)?.[1] ?? ''))) throw new Error('telegram outbox schema upgrade failed')
    }
  }
}

const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, '0')).join('')

export interface TelegramMessage {
  id: string
  chatId: string
  text: string
  wallet?: string
  now: number
  dueAt?: number
  silenceGuard?: { chainId: number; jobId: string; until: number }
}

function outboxStatement(input: TelegramMessage, webhook?: { id: string; claim: string }): Statement {
  return stmt(
    `INSERT OR IGNORE INTO telegram_outbox (id, chat_id, wallet, text, status, due_at, created_at, guard_chain_id, guard_job_id, guard_until)
     SELECT ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ? ${webhook === undefined ? '' : 'WHERE EXISTS (SELECT 1 FROM telegram_updates WHERE id = ? AND claim_token = ?) '}`,
    input.id, input.chatId, input.wallet?.toLowerCase() ?? null, input.text.slice(0, 4096), input.dueAt ?? input.now, input.now,
    input.silenceGuard?.chainId ?? null, input.silenceGuard?.jobId ?? null, input.silenceGuard?.until ?? null,
    ...(webhook === undefined ? [] : [webhook.id, webhook.claim]),
  )
}

/** All recipients come from verified wallet links or fixed release configuration. */
export async function enqueueTelegram(sql: AsyncSql, input: TelegramMessage): Promise<void> {
  if (input.chatId === '' || input.text === '') return
  await sql.batch([outboxStatement(input)])
}

export async function enqueueWalletNotification(sql: AsyncSql, network: Network, wallet: string | null, input: Omit<TelegramMessage, 'chatId' | 'wallet'>): Promise<void> {
  if (wallet === null) return
  const [link] = await sql.all<{ chat_id: string }>('SELECT chat_id FROM telegram_links WHERE chain_id = ? AND wallet = ?', chainIdOf(network), wallet.toLowerCase())
  if (link !== undefined) await enqueueTelegram(sql, { ...input, chatId: link.chat_id, wallet })
}

export async function telegramStatus(sql: AsyncSql, network: Network, wallet: string) {
  const [row] = await sql.all<{ username: string | null; linked_at: number }>('SELECT username, linked_at FROM telegram_links WHERE chain_id = ? AND wallet = ?', chainIdOf(network), wallet.toLowerCase())
  return { linked: row !== undefined, username: row?.username ?? null, linkedAt: row?.linked_at ?? null }
}

export async function telegramUnlink(sql: AsyncSql, network: Network, wallet: string): Promise<{ linked: false }> {
  await sql.batch([
    stmt("UPDATE telegram_outbox SET status = 'cancelled' WHERE wallet = ? AND status = 'pending'", wallet.toLowerCase()),
    stmt('DELETE FROM telegram_links WHERE chain_id = ? AND wallet = ?', chainIdOf(network), wallet.toLowerCase()),
    stmt('DELETE FROM telegram_challenges WHERE chain_id = ? AND wallet = ?', chainIdOf(network), wallet.toLowerCase()),
  ])
  return { linked: false }
}

export async function telegramLinkPrepare(sql: AsyncSql, network: Network, wallet: string, now: number) {
  if (!isAddress(wallet)) throw new TelegramError('invalid', 'Wallet must be an address')
  const nonce = randomCode()
  const expiresAt = now + 15 * 60
  const message = `Link my wallet to Sidequest Telegram notifications.\nWallet: ${wallet}\nSite: ${publicOrigin()}\nChain: ${chainIdOf(network)}\nNonce: ${nonce}\nExpires: ${expiresAt}`
  await sql.batch([stmt('INSERT OR REPLACE INTO telegram_challenges (wallet, chain_id, nonce, message, expires_at) VALUES (?, ?, ?, ?, ?)', wallet.toLowerCase(), chainIdOf(network), nonce, message, expiresAt)])
  return { nonce, message, expiresAt }
}

/** EOA and ERC-1271 verification comes from the chain client; the caller must be signed in. */
export async function telegramLinkConfirm(sql: AsyncSql, network: Network, wallet: string, nonce: string, signature: string, now: number,
  verify: (input: { address: Address; message: string; signature: Hex }) => Promise<boolean>) {
  if (!isAddress(wallet) || !/^[A-Za-z0-9_-]{1,64}$/.test(nonce) || !/^0x[0-9a-f]+$/i.test(signature)) throw new TelegramError('invalid', 'A pending link and its message signature are required')
  const [row] = await sql.all<{ message: string }>(
    'SELECT message FROM telegram_challenges WHERE chain_id = ? AND wallet = ? AND nonce = ? AND expires_at > ? AND consumed_at IS NULL', chainIdOf(network), wallet.toLowerCase(), nonce, now,
  )
  if (row === undefined) throw new TelegramError('invalid', 'The link expired or was used; prepare a fresh link')
  let valid = false
  try { valid = await verify({ address: wallet as Address, message: row.message, signature: signature as Hex }) } catch { /* Invalid or unavailable verification fails closed. */ }
  if (!valid) throw new TelegramError('forbidden', 'The signature is not from your signed-in wallet over this link message')
  await sql.batch([stmt('UPDATE telegram_challenges SET confirmed_at = ? WHERE chain_id = ? AND wallet = ? AND nonce = ? AND expires_at > ? AND consumed_at IS NULL', now, chainIdOf(network), wallet.toLowerCase(), nonce, now)])
  const [confirmed] = await sql.all<{ confirmed_at: number | null }>('SELECT confirmed_at FROM telegram_challenges WHERE nonce = ? AND wallet = ? AND consumed_at IS NULL AND expires_at > ?', nonce, wallet.toLowerCase(), now)
  if (confirmed?.confirmed_at === null || confirmed === undefined) throw new TelegramError('invalid', 'The pending link changed; prepare a fresh link')
  return { pending: true, botUrl: `https://t.me/${telegramBot(network)}?start=${nonce}` }
}

/** Only authenticated private bot chats can create or remove links. Replies go through the outbox. */
export async function handleTelegramWebhook(sql: AsyncSql, network: Network, body: unknown, suppliedSecret: string | null, expectedSecret: string, now: number): Promise<{ ok: boolean; queued: boolean }> {
  if (expectedSecret === '' || suppliedSecret === null || suppliedSecret !== expectedSecret) return { ok: false, queued: false }
  if (body === null || typeof body !== 'object') return { ok: true, queued: false }
  const update = body as { update_id?: number; message?: { chat?: { id?: number; type?: string }; from?: { id?: number; is_bot?: boolean; username?: string }; text?: unknown } }
  const m = update.message
  const chat = m?.chat?.id
  if (!Number.isSafeInteger(update.update_id) || !Number.isSafeInteger(chat) || (chat ?? 0) <= 0 || m?.chat?.type !== 'private'
    || m.from?.id !== chat || m.from?.is_bot === true || typeof m.text !== 'string') return { ok: true, queued: false }
  const text = m.text.trim()
  const chatId = String(chat)
  const webhook = { id: `${chainIdOf(network)}:${update.update_id}`, claim: crypto.randomUUID() }
  const statements = [stmt('INSERT OR IGNORE INTO telegram_updates (id, claim_token, received_at) VALUES (?, ?, ?)', webhook.id, webhook.claim, now)]
  const gate = 'EXISTS (SELECT 1 FROM telegram_updates WHERE id = ? AND claim_token = ?)'
  let reply: string
  let linkNonce: string | undefined
  if (new RegExp(`^\\/start(?:@${telegramBot(network)})?(?:\\s|$)`, 'i').test(text)) {
    const nonce = text.split(/\s+/)[1] ?? ''
    const [pending] = /^[A-Za-z0-9_-]{1,64}$/.test(nonce)
      ? await sql.all<{ wallet: string }>('SELECT wallet FROM telegram_challenges WHERE chain_id = ? AND nonce = ? AND confirmed_at IS NOT NULL AND consumed_at IS NULL AND expires_at > ?', chainIdOf(network), nonce, now)
      : []
    if (pending === undefined) reply = `Link your wallet in Sidequest first:\n${publicOrigin()}/telegram`
    else {
      const username = typeof m.from?.username === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(m.from.username) ? m.from.username : null
      statements.push(
        stmt(`UPDATE telegram_challenges SET consumed_at = ?, consume_token = ? WHERE chain_id = ? AND nonce = ? AND confirmed_at IS NOT NULL AND consumed_at IS NULL AND expires_at > ? AND ${gate}`, now, webhook.claim, chainIdOf(network), nonce, now, webhook.id, webhook.claim),
        stmt(`INSERT OR REPLACE INTO telegram_links (chat_id, chain_id, wallet, username, linked_at)
          SELECT ?, chain_id, wallet, ?, ? FROM telegram_challenges WHERE nonce = ? AND consume_token = ?`, chatId, username, now, nonce, webhook.claim),
      )
      reply = 'Your wallet is linked to Sidequest job notifications. Use /stop to turn them off.'
      linkNonce = nonce
    }
  } else if (new RegExp(`^\\/stop(?:@${telegramBot(network)})?(?:\\s|$)`, 'i').test(text)) {
    statements.push(
      stmt(`UPDATE telegram_outbox SET status = 'cancelled' WHERE chat_id = ? AND status = 'pending' AND ${gate}`, chatId, webhook.id, webhook.claim),
      stmt(`DELETE FROM telegram_challenges WHERE wallet IN (SELECT wallet FROM telegram_links WHERE chat_id = ?) AND ${gate}`, chatId, webhook.id, webhook.claim),
      stmt(`DELETE FROM telegram_links WHERE chat_id = ? AND ${gate}`, chatId, webhook.id, webhook.claim),
    )
    reply = 'Sidequest notifications are off. Link your wallet again in Sidequest to turn them on.'
  } else if (text !== '') reply = `Link your wallet in Sidequest:\n${publicOrigin()}/telegram\nOr send /stop to turn off notifications.`
  else return { ok: true, queued: false }
  if (linkNonce === undefined) statements.push(outboxStatement({ id: `telegram:reply:${webhook.id}`, chatId, text: reply, now }, webhook))
  else statements.push(stmt(`INSERT OR IGNORE INTO telegram_outbox (id, chat_id, text, status, due_at, created_at)
    SELECT ?, ?, CASE WHEN EXISTS (SELECT 1 FROM telegram_challenges WHERE nonce = ? AND consume_token = ?)
      THEN ? ELSE ? END, 'pending', ?, ? WHERE ${gate}`,
    `telegram:reply:${webhook.id}`, chatId, linkNonce, webhook.claim, reply,
    `This link expired or was used. Prepare a fresh link in Sidequest:\n${publicOrigin()}/telegram`, now, now, webhook.id, webhook.claim))
  await sql.batch(statements)
  const [owned] = await sql.all('SELECT id FROM telegram_updates WHERE id = ? AND claim_token = ?', webhook.id, webhook.claim)
  return { ok: true, queued: owned !== undefined }
}

class DeliveryFailure extends Error {
  constructor(readonly kind: 'retry' | 'failed' | 'uncertain', readonly retryAfter = 60) { super(`Telegram delivery ${kind}`) }
}

export function telegramTransport(token: string, transport: typeof fetch = fetch): TelegramTransport {
  return { async sendMessage(chatId, text) {
    if (token === '') throw new DeliveryFailure('failed')
    let response: Response
    try {
      // workerd rejects redirect 'error' before sending; 'manual' plus the 3xx check below refuses redirects instead.
      response = await transport(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(15_000),
      })
    } catch { throw new DeliveryFailure('uncertain') }
    if (response.status >= 300 && response.status < 400) throw new DeliveryFailure('failed')
    let payload: { ok?: boolean; result?: { message_id?: number }; parameters?: { retry_after?: number } }
    try { payload = await response.json() as typeof payload } catch { throw new DeliveryFailure('uncertain') }
    if (response.status === 429 && payload.ok === false) throw new DeliveryFailure('retry', Math.max(1, Math.min(payload.parameters?.retry_after ?? 60, 86_400)))
    if (payload.ok === false) throw new DeliveryFailure('failed')
    if (!response.ok || payload.ok !== true || !Number.isSafeInteger(payload.result?.message_id) || (payload.result?.message_id ?? 0) <= 0) throw new DeliveryFailure('uncertain')
    return { messageId: payload.result!.message_id! }
  } }
}

/** Claim before sending. Unknown outcomes remain visible and never automatically resend. */
export async function drainTelegramOutbox(sql: AsyncSql, transport: TelegramTransport, now: number, limit = 20, allowSilence = false) {
  await sql.batch([stmt("UPDATE telegram_outbox SET status = 'uncertain', last_error = 'delivery-unknown', lease_token = NULL WHERE status = 'sending' AND lease_until < ?", now)])
  const rows = await sql.all<{ id: string; chat_id: string; wallet: string | null; text: string; guard_chain_id: number | null; guard_job_id: string | null; guard_until: number | null }>(
    "SELECT * FROM telegram_outbox WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, created_at LIMIT ?", now, Math.max(1, Math.min(limit, 100)),
  )
  let sent = 0, uncertain = 0, failed = 0
  for (const row of rows) {
    const lease = crypto.randomUUID()
    await sql.batch([stmt("UPDATE telegram_outbox SET status = 'sending', attempts = attempts + 1, lease_token = ?, lease_until = ? WHERE id = ? AND status = 'pending' AND due_at <= ?", lease, now + 60, row.id, now)])
    const [owned] = await sql.all<{ lease_token: string | null }>('SELECT lease_token FROM telegram_outbox WHERE id = ?', row.id)
    if (owned?.lease_token !== lease) continue
    if (row.guard_job_id !== null) {
      if (!allowSilence) {
        await sql.batch([stmt("UPDATE telegram_outbox SET status = 'pending', due_at = ?, lease_token = NULL WHERE id = ? AND lease_token = ?", now + 60, row.id, lease)])
        continue
      }
      const [job] = await sql.all("SELECT job_id FROM jobs WHERE chain_id = ? AND job_id = ? AND status = 'submitted' AND (outcome IS NULL OR outcome = 'None')", row.guard_chain_id, row.guard_job_id)
      if (job === undefined || (row.guard_until ?? 0) <= now) {
        await sql.batch([stmt("UPDATE telegram_outbox SET status = 'cancelled', lease_token = NULL WHERE id = ? AND lease_token = ?", row.id, lease)])
        continue
      }
    }
    if (row.wallet !== null) {
      const [link] = await sql.all('SELECT chat_id FROM telegram_links WHERE chat_id = ? AND wallet = ?', row.chat_id, row.wallet)
      if (link === undefined) {
        await sql.batch([stmt("UPDATE telegram_outbox SET status = 'cancelled', lease_token = NULL WHERE id = ? AND lease_token = ?", row.id, lease)])
        continue
      }
    }
    try {
      const receipt = await transport.sendMessage(row.chat_id, row.text)
      if (!Number.isSafeInteger(receipt.messageId) || receipt.messageId <= 0) throw new DeliveryFailure('uncertain')
      await sql.batch([stmt("UPDATE telegram_outbox SET status = 'sent', lease_token = NULL, lease_until = NULL, telegram_message_id = ?, sent_at = ? WHERE id = ? AND lease_token = ?", receipt.messageId, now, row.id, lease)])
      sent++
    } catch (error) {
      const kind = error instanceof DeliveryFailure ? error.kind : 'uncertain'
      const state = kind === 'retry' ? 'pending' : kind
      await sql.batch([stmt('UPDATE telegram_outbox SET status = ?, due_at = ?, lease_token = NULL, lease_until = NULL, last_error = ? WHERE id = ? AND lease_token = ?',
        state, now + (error instanceof DeliveryFailure ? error.retryAfter : 60), `delivery-${kind}`, row.id, lease)])
      if (kind === 'uncertain') uncertain++
      if (kind === 'failed') failed++
    }
  }
  return { sent, uncertain, failed }
}

export async function enqueuePublicRequest(sql: AsyncSql, channelId: string, input: { boardId: string; taskId: string; title?: string; network: Network; now: number; kind: 'job' | 'quotes' }) {
  if (channelId === '') { console.info('Telegram public request skipped: channel unset', input.network); return }
  const boardPath = input.boardId === 'public' ? '' : `/b/${encodeURIComponent(input.boardId)}`
  await enqueueTelegram(sql, { id: `telegram:request:${input.boardId}:${input.taskId}`, chatId: channelId,
    text: `New Sidequest request${input.title === undefined ? '' : `: ${input.title.slice(0, 200)}`}\n${publicOrigin()}${boardPath}/${input.kind === 'job' ? 'job' : 'quotes'}/${encodeURIComponent(input.taskId)}`, now: input.now })
}
