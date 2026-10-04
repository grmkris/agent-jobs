/** Local-only probe for the existing Board namespace. Never part of the release graph. */
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { migrateFleet, createManagedAgent, type FleetSql } from '@agent-jobs/board'
import Board from '../src/board.ts'
import { fleetRoute } from '../src/fleet-routes.ts'

export default class FleetProbe extends Cloudflare.Worker<FleetProbe>()('HirelingFleetLocalProbe', {
  main: import.meta.url,
  compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
  env: { NETWORK: 'monad-testnet', DEPLOY_STAGE: 'local', PROD_ADMISSION_DRAIN: '0' },
}, Effect.gen(function* () {
  const boards = yield* Board
  return { fetch: Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const input = (yield* req.json) as unknown as { method: string; path: string; body: Record<string, unknown>; owner?: string; bearer?: string }
    const object = boards.getByName('__hireling_fleet_v1__')
    const sql: FleetSql = {
      all: async <T>(query: string, ...params: (string | number | null)[]) => JSON.parse(await Effect.runPromise(object.fleet({ kind: 'all', query, params }))) as T[],
      batch: async statements => { await Effect.runPromise(object.fleet({ kind: 'batch', statements })) },
    }
    yield* Effect.promise(() => migrateFleet(sql))
    if (input.path === '/seed') {
      const agent = yield* Effect.promise(() => createManagedAgent(sql, { owner: input.owner!, name: 'Local workerd worker', walletAddress: '0x1111111111111111111111111111111111111111', kind: 'external', now: Math.floor(Date.now() / 1000) }))
      return HttpServerResponse.jsonUnsafe({ ok: true, result: { agent } })
    }
    const reply = yield* Effect.promise(() => fleetRoute({ sql, ...input, origin: 'https://workerd.test.invalid', now: Math.floor(Date.now() / 1000), network: 'monad-testnet', rpcUrl: '', appId: '' }))
    return HttpServerResponse.jsonUnsafe(reply?.body, { status: reply?.status ?? 404 })
  }) }
})) {}
