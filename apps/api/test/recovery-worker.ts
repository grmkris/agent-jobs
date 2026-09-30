import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as sdk from '@agent-jobs/sdk'
import { contractsOf, DERIVED_TABLES, fromD1, migrate, resetIndex, runOnce, stmt, type IndexerConfig, type RawLog } from '@agent-jobs/indexer'
import fixture from '../../../packages/indexer/test/fixtures/testnet-logs.json' with { type: 'json' }

const Source = Cloudflare.D1.Database('E38DrillSource')
const Restore = Cloudflare.D1.Database('E38DrillRestore')

export default class RecoveryDrill extends Cloudflare.Worker<RecoveryDrill>()('E38RecoveryDrill', {
  main: import.meta.url,
  compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
}, Effect.gen(function* () {
  const sourceBinding = yield* Cloudflare.D1.QueryDatabase(Source)
  const restoreBinding = yield* Cloudflare.D1.QueryDatabase(Restore)
  return {
    fetch: Effect.gen(function* () {
      const source = fromD1((yield* sourceBinding.raw) as never)
      const restore = fromD1((yield* restoreBinding.raw) as never)
      const result = yield* Effect.promise(async () => {
        await migrate(source)
        await migrate(restore)
        for (const database of [source, restore]) await database.batch([
          stmt('CREATE TABLE IF NOT EXISTS e38_hosted_fixture (id TEXT PRIMARY KEY, body TEXT NOT NULL)'),
          stmt("INSERT OR REPLACE INTO e38_hosted_fixture VALUES ('retain', 'hosted-only')"),
        ])
        const contracts = contractsOf('monad-testnet')
        const config: IndexerConfig = {
          contracts, deployBlock: Number(sdk.deployment('monad-testnet').deployBlock), runner: 'e38-d1-drill', maxPages: 1, backfillBlocks: 0,
          source: { logs: async query => ({ nextBlock: fixture.toBlock, logs: (fixture.logs as RawLog[]).filter(log => log.block_number >= query.fromBlock && log.block_number < fixture.toBlock) }) },
          head: { finalizedBlock: async () => fixture.toBlock - 1, blockHash: async block => `0x${block.toString(16).padStart(64, '0')}` },
        }
        await resetIndex(source, config)
        const indexed = await runOnce(source, config)
        const tables = ['events', ...DERIVED_TABLES, 'checkpoint', 'block_times']
        await resetIndex(restore, config)
        for (const table of tables) {
          const rows = await source.all<Record<string, string | number | null>>(`SELECT * FROM ${table} ORDER BY rowid`)
          await restore.batch([stmt(`DELETE FROM ${table}`), ...rows.map(row => {
            const columns = Object.keys(row)
            return stmt(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...Object.values(row))
          })])
        }
        for (const table of tables) {
          const before = await source.all(`SELECT * FROM ${table} ORDER BY rowid`)
          const after = await restore.all(`SELECT * FROM ${table} ORDER BY rowid`)
          if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`D1 restore differs: ${table}`)
        }
        await resetIndex(restore, config)
        const rebuilt = await runOnce(restore, config)
        for (const table of ['events', ...DERIVED_TABLES]) {
          const before = await source.all(`SELECT * FROM ${table} ORDER BY rowid`)
          const after = await restore.all(`SELECT * FROM ${table} ORDER BY rowid`)
          if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`D1 rebuild differs: ${table}`)
        }
        const hosted = await restore.all<{ body: string }>("SELECT body FROM e38_hosted_fixture WHERE id = 'retain'")
        return { ok: indexed.events > 0 && rebuilt.events === indexed.events && hosted[0]?.body === 'hosted-only', runtime: navigator.userAgent, events: indexed.events, jobs: indexed.jobs, restored: true, rebuilt: true, hostedRowsRetained: hosted[0]?.body === 'hosted-only' }
      })
      return HttpServerResponse.jsonUnsafe(result)
    }).pipe(Effect.orDie),
  }
}).pipe(Effect.provide(Layer.mergeAll(Cloudflare.D1.QueryDatabaseBinding)))) {}
