import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { verifyMessage } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { fromD1, migrate, stmt } from '@agent-jobs/indexer'
import { drainTelegramOutbox, handleTelegramWebhook, migrateTelegram, telegramLinkConfirm, telegramLinkPrepare, telegramStatus } from '../src/telegram.ts'
import { queueTelegramNotifications } from '../src/telegram-notifications.ts'

const Database = Cloudflare.D1.Database('HirelingTelegramLocalDatabase')
export default class TelegramDrill extends Cloudflare.Worker<TelegramDrill>()('HirelingTelegramLocalDrill', {
  main: import.meta.url, compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
}, Effect.gen(function* () {
  const binding = yield* Cloudflare.D1.QueryDatabase(Database)
  return { fetch: Effect.gen(function* () {
    const sql = fromD1((yield* binding.raw) as never)
    const result = yield* Effect.promise(async () => {
      await migrate(sql)
      await migrateTelegram(sql)
      await sql.batch(['telegram_outbox', 'telegram_links', 'telegram_updates', 'telegram_challenges', 'telegram_notified_events', 'events', 'jobs', 'checkpoint', 'block_times'].map(t => stmt(`DELETE FROM ${t}`)))
      const account = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123')
      const prepared = await telegramLinkPrepare(sql, 'monad-testnet', account.address, 100)
      await telegramLinkConfirm(sql, 'monad-testnet', account.address, prepared.nonce, await account.signMessage({ message: prepared.message }), 101, verifyMessage)
      const update = { update_id: 1, message: { chat: { id: 42, type: 'private' }, from: { id: 42, username: 'local_fixture' }, text: `/start ${prepared.nonce}` } }
      const linked = await handleTelegramWebhook(sql, 'monad-testnet', update, 'fixture-secret', 'fixture-secret', 102)
      const duplicate = await handleTelegramWebhook(sql, 'monad-testnet', update, 'fixture-secret', 'fixture-secret', 103)
      await sql.batch([
        stmt('INSERT INTO checkpoint VALUES (10143, 100, NULL, 104)'),
        stmt("INSERT INTO jobs (chain_id, job_id, creator, approver, worker, kind, status, updated_block) VALUES (10143, '1', ?, ?, ?, 'hireling-v1', 'submitted', 99)", account.address, account.address, account.address),
        stmt("INSERT INTO events VALUES (10143, ?, 99, 1, 'fixture-tx', '1', 'JobSubmitted', '{}')", account.address),
        stmt('INSERT INTO block_times VALUES (10143, 99, 104)'),
      ])
      const queued = await queueTelegramNotifications(sql, 'monad-testnet', 104)
      let sent = 0
      const transport = { sendMessage: async () => ({ messageId: ++sent }) }
      const drained = await Promise.all([drainTelegramOutbox(sql, transport, 104), drainTelegramOutbox(sql, transport, 104)])
      const receipts = await sql.all<{ status: string; telegram_message_id: number }>('SELECT status, telegram_message_id FROM telegram_outbox')
      return { runtime: navigator.userAgent, linked: linked.queued && (await telegramStatus(sql, 'monad-testnet', account.address)).linked, duplicate: duplicate.queued,
        queued: queued.processed, sent, counted: drained.reduce((n, r) => n + r.sent, 0), receipts }
    })
    return HttpServerResponse.jsonUnsafe(result)
  }).pipe(Effect.orDie) }
}).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding))) {}
