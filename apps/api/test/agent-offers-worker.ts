/** Test-only local D1/R2 publisher; no provider or storage doubles. */
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { fromD1 } from '@sidequest/indexer'
import type { AgentPreparedCall } from '@sidequest/board'
import { publishAgentOffer, type OfferBucket } from '../src/agent-offers.ts'
import { boardOfTerms, migrateRegistry } from '../src/registry.ts'

const Database = Cloudflare.D1.Database('OfferDatabase')
const Manifests = Cloudflare.R2.Bucket('Manifests')

export default class AgentOffersProbe extends Cloudflare.Worker<AgentOffersProbe>()('AgentOffersProbe', {
  main: import.meta.url,
  compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
}, Effect.gen(function* () {
  const database = yield* Cloudflare.D1.QueryDatabase(Database)
  yield* Cloudflare.R2.ReadWriteBucket(Manifests)
  const env = yield* Cloudflare.WorkerEnvironment
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const body = (yield* request.json) as { boardId: string; action: AgentPreparedCall; unavailable?: boolean; readOnly?: boolean }
      const sql = fromD1((yield* database.raw) as never)
      const bucket = (env as Record<string, unknown>).Manifests as OfferBucket
      const result = yield* Effect.promise(async () => {
        await migrateRegistry(sql)
        try {
          if (!body.readOnly) await publishAgentOffer({ sql, bucket: body.unavailable ? undefined : bucket, boardId: body.boardId, action: body.action, now: 100 })
          const object = await bucket.get(`offers/${body.action.termsHash}.json`)
          return { ok: true, runtime: navigator.userAgent, manifest: await object?.text(), attribution: await boardOfTerms(sql, String(body.action.termsHash)) }
        } catch {
          return { ok: false, runtime: navigator.userAgent }
        }
      })
      return HttpServerResponse.jsonUnsafe(result)
    }),
  }
}).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding), Effect.provide(Cloudflare.R2.ReadWriteBucketBinding))) {}
