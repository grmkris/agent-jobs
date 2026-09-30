import { SESSION_SCHEMA } from '@agent-jobs/board'
import { fromD1 } from '@agent-jobs/indexer'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import Board, { type BoardCall } from '../src/board.ts'
import { Database } from '../src/database.ts'

export default class AdmissionProbe extends Cloudflare.Worker<AdmissionProbe>()('E38AdmissionProbe', {
  main: import.meta.url,
  compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
  env: { NETWORK: 'monad-mainnet', DEPLOY_STAGE: 'prod', PROD_APPROVED_WALLETS: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', PROD_APPROVED_BOARDS: 'public', PROD_ADMISSION_DRAIN: '0', PROD_APPROVED_ACTIONS: 'create_task,apply,submit_work' },
}, Effect.gen(function* () {
  const boards = yield* Board
  const facts = yield* Cloudflare.D1.QueryDatabase(Database)
  return {
    fetch: Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      const body = (yield* req.json) as unknown as { name: string; call: BoardCall }
      const sql = fromD1((yield* facts.raw) as never)
      yield* Effect.promise(() => sql.batch(SESSION_SCHEMA.map(query => ({ query, params: [] }))))
      const reply = yield* boards.getByName(body.name).call(body.call)
      return HttpServerResponse.text(reply, { headers: { 'content-type': 'application/json' } })
    }),
  }
}).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding))) {}
