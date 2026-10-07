import { contractsOf, fromD1, hyperSync, migrate, releaseLease, rpcHead, runOnce } from '@sidequest/indexer'
import * as sdk from '@sidequest/sdk'
import devInfrastructure from '../../../infra/dev.json' with { type: 'json' }
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { Database } from '../../api/src/database.ts'
import { rpcUrlForNetwork } from '../../api/src/network.ts'
import { runtimeSecret } from '../../api/src/prod-config.ts'
import { queueTelegramNotifications } from '../../api/src/telegram-notifications.ts'
import { drainTelegramOutbox, migrateTelegram, telegramTransport } from '../../api/src/telegram.ts'
import { reportRelayWatchFailure, watchRelay } from '../../api/src/relay-watch.ts'
import { feedFromChain, pruneFeed, reportFeedFailure } from '../../api/src/feed.ts'
import { deliverWebhooks, reportWebhookFailure } from '../../api/src/webhooks.ts'
import { recordIndexerRun, type IndexerRunOutcome } from './run-record.ts'

const secret = (name: string) =>
  Config.Redacted(name).pipe(Effect.map((v) => (Redacted.value(v) === 'unset' ? '' : Redacted.value(v))))

/**
 * The chain-facts indexer (spec §5 `apps/indexer`, plan S4): every minute, under the lease in D1, index finalized
 * logs of the core, Holdings and evaluators from HyperSync into D1. The only D1 writer; Explore reads.
 * `GET /status` reports the checkpoint.
 */
export default class Indexer extends Cloudflare.Worker<Indexer>()(
  'Indexer',
  {
    main: import.meta.url,
    ...(process.env.SIDEQUEST_STAGE === 'dev' ? { name: devInfrastructure.resources.Indexer } : {}),
    compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
    dev: { port: 8789 },
    env: {
      NETWORK: process.env.SIDEQUEST_NETWORK ?? 'monad-testnet',
      HYPERSYNC_URL: process.env.HYPERSYNC_URL ?? (process.env.SIDEQUEST_NETWORK === 'monad-mainnet' ? 'https://monad.hypersync.xyz' : 'https://monad-testnet.hypersync.xyz'),
      MONAD_RPC_URL: Redacted.make(rpcUrlForNetwork() || 'unset'),
      HYPERSYNC_API_TOKEN: Redacted.make(runtimeSecret('HYPERSYNC_API_TOKEN') || 'unset'),
      TELEGRAM_BOT_TOKEN: Redacted.make(runtimeSecret('TELEGRAM_BOT_TOKEN') || 'unset'),
    },
  },
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(Database)

    /** The last cron outcome, kept in D1 for `GET /` (Workers logs need a permission the deploy token lacks). */
    const record = (outcome: IndexerRunOutcome) =>
      Effect.gen(function* () {
        const raw = yield* db.raw
        const sql = fromD1(raw as never)
        yield* Effect.promise(() => recordIndexerRun(sql, outcome, Math.floor(Date.now() / 1000)))
      })

    const run = Effect.gen(function* () {
      const network = (yield* Config.String('NETWORK')) as sdk.Network
      const token = yield* secret('HYPERSYNC_API_TOKEN')
      const rpcUrl = yield* secret('MONAD_RPC_URL')
      const telegramToken = yield* secret('TELEGRAM_BOT_TOKEN')
      const raw = yield* db.raw
      const sql = fromD1(raw as never)
      yield* Effect.promise(() => migrateTelegram(sql))
      if (token === '' || rpcUrl === '') {
        if (telegramToken !== '') yield* Effect.promise(() => drainTelegramOutbox(sql, telegramTransport(telegramToken), Math.floor(Date.now() / 1000)))
        return { skipped: 'HYPERSYNC_API_TOKEN or MONAD_RPC_URL unset' }
      }
      const hyper = yield* Config.String('HYPERSYNC_URL')
      return yield* Effect.promise(async () => {
        await migrate(sql)
        let allowSilence = false
        const indexer = {
          contracts: contractsOf(network),
          deployBlock: Number(sdk.deployment(network).deployBlock),
          source: hyperSync(hyper, token),
          head: rpcHead(rpcUrl),
          runner: `cron:${crypto.randomUUID()}`,
          maxPages: 5,
        }
        try {
          const result = await runOnce(sql, indexer)
          // Judged against the head this run indexed to. A second head lookup here raced a chain that finalizes
          // several blocks a second, so it almost never passed and the feed and notifications stood still.
          const caughtUp = result.caughtUp
          // The inbox feed (V1.1 WS4) follows finalized transitions whether or not Telegram is configured.
          const fedAt = Math.floor(Date.now() / 1000)
          // 100 events is about 300 D1 statements, so a catch-up run leaves room for the Telegram queue below.
          await feedFromChain(sql, network, fedAt, { caughtUp, limit: 100 }).catch(reportFeedFailure)
          if (fedAt % 3600 < 60) await pruneFeed(sql, fedAt).catch(reportFeedFailure)
          // Webhooks send what the feed holds; board and approval events arrive whether or not the chain index is caught up.
          await deliverWebhooks(sql, network, fedAt).catch(reportWebhookFailure)
          if (telegramToken !== '') {
            const now = Math.floor(Date.now() / 1000)
            const deployment = sdk.deployment(network)
            const client = sdk.context(network, 'main', rpcUrl).publicClient
            const notifications = await queueTelegramNotifications(sql, network, now, { caughtUp })
            allowSilence = !notifications.stale
            // Owner alert when the sponsorship relay nears its floor; never fails the indexing run.
            await watchRelay(sql, { network, now, relay: deployment.relay, balance: () => client.getBalance({ address: deployment.relay }) })
              .catch(reportRelayWatchFailure)
          }
          return result
        } finally {
          // The next minute's run indexes at once instead of being refused while this lease runs out. A failed
          // release only means waiting for expiry, as before.
          await releaseLease(sql, indexer).catch(() => undefined)
          if (telegramToken !== '') await drainTelegramOutbox(sql, telegramTransport(telegramToken), Math.floor(Date.now() / 1000), 20, allowSilence)
        }
      })
    })

    yield* Cloudflare.Workers.cron('* * * * *', () =>
      run.pipe(
        Effect.flatMap((r) => record({ ok: true, result: r })),
        Effect.catchCause((c) => record({ ok: false, cause: c }).pipe(Effect.ignore)),
      ),
    )

    return {
      fetch: Effect.gen(function* () {
        const raw = yield* db.raw
        const rows = yield* Effect.promise(async () => {
          const sql = fromD1(raw as never)
          await migrate(sql)
          return {
            checkpoint: await sql.all('SELECT chain_id, next_block, updated_at FROM checkpoint'),
            jobs: await sql.all<{ n: number }>('SELECT count(*) AS n FROM jobs'),
            lastRun: await sql.all('SELECT at, ok, detail FROM indexer_runs').catch(() => []),
          }
        })
        return HttpServerResponse.jsonUnsafe({ ok: true, ...rows })
      }),
    }
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.Workers.CronEventSourceLive, Cloudflare.D1.QueryDatabaseBinding))),
) {}
