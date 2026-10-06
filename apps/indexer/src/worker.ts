import { contractsOf, fromD1, hyperSync, migrate, rpcHead, runOnce } from '@agent-jobs/indexer'
import * as sdk from '@agent-jobs/sdk'
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
    compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
    dev: { port: 8789 },
    env: {
      NETWORK: process.env.AGENT_JOBS_NETWORK ?? 'monad-testnet',
      HYPERSYNC_URL: process.env.HYPERSYNC_URL ?? (process.env.AGENT_JOBS_NETWORK === 'monad-mainnet' ? 'https://monad.hypersync.xyz' : 'https://monad-testnet.hypersync.xyz'),
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
        try {
          const head = rpcHead(rpcUrl)
          const result = await runOnce(sql, {
            contracts: contractsOf(network),
            deployBlock: Number(sdk.deployment(network).deployBlock),
            source: hyperSync(hyper, token),
            head,
            runner: `cron:${crypto.randomUUID()}`,
            maxPages: 5,
          })
          // A failed head lookup only marks the run as not caught up; the committed indexing result stands (VV2-025).
          const finalized = await head.finalizedBlock().catch((error: unknown) => { reportFeedFailure(error); return null })
          const caughtUp = result.nextBlock !== null && finalized !== null && result.nextBlock > finalized
          // The inbox feed (V1.1 WS4) follows finalized transitions whether or not Telegram is configured.
          const fedAt = Math.floor(Date.now() / 1000)
          await feedFromChain(sql, network, fedAt, { caughtUp }).catch(reportFeedFailure)
          if (fedAt % 3600 < 60) await pruneFeed(sql, fedAt).catch(reportFeedFailure)
          if (telegramToken !== '') {
            const now = Math.floor(Date.now() / 1000)
            const deployment = sdk.deployment(network)
            const client = sdk.context(network, 'main', rpcUrl).publicClient
            const notifications = await queueTelegramNotifications(sql, network, now, { caughtUp, legacyReviewWindow: async (job) => {
              const pair = Object.entries({ ...deployment.stacks, ...deployment.legacyStacks }).find(([name]) => name === job.stack)?.[1]
              if (pair === undefined || pair.kind !== 'legacy') return null
              return Number(await client.readContract({ address: pair.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'reviewWindow' }))
            } })
            allowSilence = !notifications.stale
            // Owner alert when the sponsorship relay nears its floor; never fails the indexing run.
            await watchRelay(sql, { network, now, relay: deployment.relay, balance: () => client.getBalance({ address: deployment.relay }) })
              .catch(reportRelayWatchFailure)
          }
          return result
        } finally {
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
