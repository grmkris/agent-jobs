import { DatabaseSync } from 'node:sqlite'
import { verifyMessage } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { type AsyncSql, fromNodeSqlite } from '@agent-jobs/indexer'
import {
  drainTelegramOutbox, handleTelegramWebhook, migrateTelegram, telegramLinkConfirm, telegramLinkPrepare,
  telegramPublicChannel, telegramStatus,
} from '../src/telegram.ts'

const account = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123')
const chat = 987654321

async function db(): Promise<AsyncSql> {
  const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
  await migrateTelegram(sql)
  return sql
}

describe('Telegram wallet links and outbox', () => {
  it('keeps public channels in code config and empty placeholders skip posts', () => {
    expect(telegramPublicChannel('monad-testnet')).toBe('')
    expect(telegramPublicChannel('monad-mainnet')).toBe('')
  })

  it('prepares and verifies the signed wallet link before /start consumes it', async () => {
    const sql = await db()
    const prepared = await telegramLinkPrepare(sql, 'monad-testnet', account.address, 100)
    expect(prepared.nonce).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(prepared.message).toContain(account.address)
    const signature = await account.signMessage({ message: prepared.message })
    const confirmed = await telegramLinkConfirm(sql, 'monad-testnet', account.address, prepared.nonce, signature, 101, verifyMessage)
    expect(confirmed.botUrl).toBe(`https://t.me/hireling_xyz_bot?start=${prepared.nonce}`)
    expect((await telegramStatus(sql, 'monad-testnet', account.address))).toMatchObject({ linked: false, username: null, linkedAt: null })
    const update = { update_id: 1, message: { chat: { id: chat, type: 'private' }, from: { id: chat, username: 'kris' }, text: `/start ${prepared.nonce}` } }
    expect(await handleTelegramWebhook(sql, 'monad-testnet', update, 'secret', 'secret', 102)).toEqual({ ok: true, queued: true })
    expect(await telegramStatus(sql, 'monad-testnet', account.address)).toMatchObject({ linked: true, username: 'kris', linkedAt: 102 })
    expect(await handleTelegramWebhook(sql, 'monad-testnet', update, 'secret', 'secret', 103)).toEqual({ ok: true, queued: false })
  })

  it('rejects an invalid webhook secret and non-private bot updates', async () => {
    const sql = await db()
    const update = { update_id: 1, message: { chat: { id: chat, type: 'group' }, from: { id: chat }, text: '/start' } }
    expect(await handleTelegramWebhook(sql, 'monad-testnet', update, 'wrong', 'secret', 100)).toEqual({ ok: false, queued: false })
    expect(await handleTelegramWebhook(sql, 'monad-testnet', update, 'secret', 'secret', 100)).toEqual({ ok: true, queued: false })
    expect(await sql.all('SELECT * FROM telegram_outbox')).toEqual([])
  })

  it('leases outbox sends, deduplicates rows, and leaves uncertain delivery visible', async () => {
    const sql = await db()
    const prepared = await telegramLinkPrepare(sql, 'monad-testnet', account.address, 100)
    const signature = await account.signMessage({ message: prepared.message })
    await telegramLinkConfirm(sql, 'monad-testnet', account.address, prepared.nonce, signature, 101, verifyMessage)
    await handleTelegramWebhook(sql, 'monad-testnet', { update_id: 2, message: { chat: { id: chat, type: 'private' }, from: { id: chat }, text: `/start ${prepared.nonce}` } }, 'secret', 'secret', 102)
    const sent: string[] = []
    expect(await drainTelegramOutbox(sql, { sendMessage: async (_chat, text) => (sent.push(text), { messageId: 77 }) }, 103)).toEqual({ sent: 1, uncertain: 0, failed: 0 })
    expect(sent[0]).toContain('wallet is linked')
    expect(await drainTelegramOutbox(sql, { sendMessage: async () => ({ messageId: 78 }) }, 104)).toEqual({ sent: 0, uncertain: 0, failed: 0 })
    const second = await telegramLinkPrepare(sql, 'monad-testnet', account.address, 200)
    await telegramLinkConfirm(sql, 'monad-testnet', account.address, second.nonce, await account.signMessage({ message: second.message }), 201, verifyMessage)
    await handleTelegramWebhook(sql, 'monad-testnet', { update_id: 3, message: { chat: { id: chat, type: 'private' }, from: { id: chat }, text: `/start ${second.nonce}` } }, 'secret', 'secret', 202)
    expect(await drainTelegramOutbox(sql, { sendMessage: async () => { throw new Error('network uncertain') } }, 203)).toMatchObject({ sent: 0, uncertain: 1 })
    expect((await sql.all<{ status: string }>("SELECT status FROM telegram_outbox WHERE status = 'uncertain'"))).toHaveLength(1)
  })
})

describe('link security and delivery reconciliation', () => {
  it('rejects expired, replaced, used and wrong-wallet signatures', async () => {
    const sql = await db()
    const a = await telegramLinkPrepare(sql, 'monad-testnet', account.address, 100)
    const signature = await account.signMessage({ message: a.message })
    await expect(telegramLinkConfirm(sql, 'monad-testnet', account.address, a.nonce, signature, a.expiresAt, verifyMessage)).rejects.toThrow(/expired/)
    await expect(telegramLinkConfirm(sql, 'monad-mainnet', account.address, a.nonce, signature, 101, verifyMessage)).rejects.toThrow(/expired/)
    const b = await telegramLinkPrepare(sql, 'monad-testnet', account.address, 101)
    await expect(telegramLinkConfirm(sql, 'monad-testnet', account.address, a.nonce, signature, 102, verifyMessage)).rejects.toThrow(/expired/)
    await expect(telegramLinkConfirm(sql, 'monad-testnet', account.address, b.nonce, signature, 102, verifyMessage)).rejects.toThrow(/signature/)
    await telegramLinkConfirm(sql, 'monad-testnet', account.address, b.nonce, await account.signMessage({ message: b.message }), 102, verifyMessage)
    const update = (id: number, chatId: number) => ({ update_id: id, message: { chat: { id: chatId, type: 'private' }, from: { id: chatId }, text: `/start ${b.nonce}` } })
    await Promise.all([handleTelegramWebhook(sql, 'monad-testnet', update(1, chat), 'secret', 'secret', 103), handleTelegramWebhook(sql, 'monad-testnet', update(2, chat + 1), 'secret', 'secret', 103)])
    expect(await sql.all('SELECT * FROM telegram_links')).toHaveLength(1)
    const replies = await sql.all<{ text: string }>('SELECT text FROM telegram_outbox')
    expect(replies.filter(r => r.text.includes('wallet is linked'))).toHaveLength(1)
    expect(replies.filter(r => r.text.includes('expired or was used'))).toHaveLength(1)
    await expect(telegramLinkConfirm(sql, 'monad-testnet', account.address, b.nonce, await account.signMessage({ message: b.message }), 104, verifyMessage)).rejects.toThrow(/expired/)
  })

  it('allows only the signed-in wallet in all REST/MCP tool shapes and registers admission', async () => {
    const { telegramTools } = await import('../src/tools-telegram.ts')
    const { hostedToolNames, readOnlyHostedTools } = await import('@agent-jobs/board')
    const sql = await db()
    const deps = { sql, network: 'monad-testnet' as const, configured: true, now: () => 100, verify: verifyMessage }
    for (const name of Object.keys(telegramTools)) expect(hostedToolNames.has(name)).toBe(true)
    expect(readOnlyHostedTools.has('telegram_status')).toBe(true)
    await expect(telegramTools.telegram_status!.run(deps, undefined, { wallet: account.address })).rejects.toThrow(/Sign in/)
    await expect(telegramTools.telegram_link_prepare!.run(deps, account.address, { wallet: '0x1111111111111111111111111111111111111111' })).rejects.toThrow(/only/)
    await expect(telegramTools.telegram_link_prepare!.run({ ...deps, configured: false }, account.address, { wallet: account.address })).rejects.toThrow(/not configured/)
  })

  it('retries an explicit rate-limit refusal, redacts errors, and never repeats an uncertain send', async () => {
    const { enqueueTelegram, telegramTransport } = await import('../src/telegram.ts')
    const sql = await db()
    await enqueueTelegram(sql, { id: 'rate', chatId: String(chat), text: 'notice', now: 100 })
    const rate = telegramTransport('fake-token', async () => Response.json({ ok: false, parameters: { retry_after: 30 } }, { status: 429 }))
    expect(await drainTelegramOutbox(sql, rate, 100)).toEqual({ sent: 0, failed: 0, uncertain: 0 })
    expect(await drainTelegramOutbox(sql, rate, 129)).toEqual({ sent: 0, failed: 0, uncertain: 0 })
    let sends = 0
    const fail = telegramTransport('fake-token', async () => { sends++; throw new Error('https://api.telegram.org/botfake-token/sendMessage') })
    await drainTelegramOutbox(sql, fail, 130)
    await drainTelegramOutbox(sql, fail, 999)
    expect(sends).toBe(1)
    expect(await sql.all('SELECT status, last_error FROM telegram_outbox')).toEqual([{ status: 'uncertain', last_error: 'delivery-uncertain' }])
  })

  it('claims concurrent drains once and cancels linked messages after /stop', async () => {
    const { enqueueTelegram } = await import('../src/telegram.ts')
    const sql = await db()
    await enqueueTelegram(sql, { id: 'one', chatId: String(chat), text: 'notice', now: 100 })
    let sends = 0
    const transport = { sendMessage: async () => { sends++; return { messageId: 1 } } }
    await Promise.all([drainTelegramOutbox(sql, transport, 100), drainTelegramOutbox(sql, transport, 100)])
    expect(sends).toBe(1)
    const prepared = await telegramLinkPrepare(sql, 'monad-testnet', account.address, 100)
    await telegramLinkConfirm(sql, 'monad-testnet', account.address, prepared.nonce, await account.signMessage({ message: prepared.message }), 101, verifyMessage)
    await handleTelegramWebhook(sql, 'monad-testnet', { update_id: 1, message: { chat: { id: chat, type: 'private' }, from: { id: chat }, text: `/start ${prepared.nonce}` } }, 'secret', 'secret', 102)
    await enqueueTelegram(sql, { id: 'linked', chatId: String(chat), wallet: account.address, text: 'delivery', now: 103 })
    await handleTelegramWebhook(sql, 'monad-testnet', { update_id: 2, message: { chat: { id: chat, type: 'private' }, from: { id: chat }, text: '/stop' } }, 'secret', 'secret', 104)
    expect((await telegramStatus(sql, 'monad-testnet', account.address)).linked).toBe(false)
    expect(await sql.all("SELECT status FROM telegram_outbox WHERE id = 'linked'")).toEqual([{ status: 'cancelled' }])
  })
})
