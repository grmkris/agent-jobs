import { contractsOf, fromD1, hyperSync, migrate, rpcHead, runOnce } from '@agent-jobs/indexer'
import * as sdk from '@agent-jobs/sdk'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { Database } from '../../api/src/database.ts'

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
      HYPERSYNC_URL: process.env.HYPERSYNC_URL ?? 'https://monad-testnet.hypersync.xyz',
      MONAD_RPC_URL: Redacted.make(process.env.MONAD_TESTNET_RPC_URL || 'unset'),
      HYPERSYNC_API_TOKEN: Redacted.make(process.env.HYPERSYNC_API_TOKEN || 'unset'),
    },
  },
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(Database)

    const run = Effect.gen(function* () {
      const network = (yield* Config.String('NETWORK')) as sdk.Network
      const token = yield* secret('HYPERSYNC_API_TOKEN')
      const rpcUrl = yield* secret('MONAD_RPC_URL')
      if (token === '' || rpcUrl === '') return { skipped: 'HYPERSYNC_API_TOKEN or MONAD_RPC_URL unset' }
      const raw = yield* db.raw
      const sql = fromD1(raw as never)
      const hyper = yield* Config.String('HYPERSYNC_URL')
      return yield* Effect.promise(async () => {
        await migrate(sql)
        return runOnce(sql, {
          contracts: contractsOf(network),
          deployBlock: Number(sdk.deployment(network).deployBlock),
          source: hyperSync(hyper, token),
          head: rpcHead(rpcUrl),
          runner: `cron:${crypto.randomUUID()}`,
          maxPages: 5,
        })
      })
    })

    yield* Cloudflare.Workers.cron('* * * * *', () =>
      run.pipe(
        Effect.tap((r) => Effect.log('indexer run', r)),
        Effect.catchCause((c) => Effect.logError('indexer run failed', c)),
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
          }
        })
        return HttpServerResponse.jsonUnsafe({ ok: true, ...rows })
      }),
    }
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.Workers.CronEventSourceLive, Cloudflare.D1.QueryDatabaseBinding))),
) {}
