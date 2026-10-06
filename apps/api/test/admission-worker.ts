import { ADMISSION_OBJECT_NAME, SESSION_SCHEMA } from '@sidequest/board'
import { fromD1 } from '@sidequest/indexer'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import type { AdmissionCall } from '../src/admission-rate.ts'
import Board, { type BoardCall } from '../src/board.ts'
import { Database } from '../src/database.ts'

export default class AdmissionProbe extends Cloudflare.Worker<AdmissionProbe>()('E38AdmissionProbe', {
  main: import.meta.url,
  compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
  env: { NETWORK: 'monad-mainnet', DEPLOY_STAGE: 'prod', PROD_ADMISSION_DRAIN: '0' },
}, Effect.gen(function* () {
  const boards = yield* Board
  const facts = yield* Cloudflare.D1.QueryDatabase(Database)
  return {
    fetch: Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      const body = (yield* req.json) as unknown as { name: string; call: BoardCall; admit?: AdmissionCall; seed?: { token: string; wallet: string } }
      const sql = fromD1((yield* facts.raw) as never)
      yield* Effect.promise(() => sql.batch(SESSION_SCHEMA.map(query => ({ query, params: [] }))))
      if (body.seed !== undefined) {
        yield* Effect.promise(() => sql.batch([{ query: 'INSERT OR REPLACE INTO sessions (id, address, origin, board_id, expires_at) VALUES (?, ?, ?, ?, ?)', params: [body.seed!.token, body.seed!.wallet, 'https://test.invalid', 'public', Math.floor(Date.now() / 1000) + 3600] }]))
      }
      const reply = body.admit === undefined
        ? yield* boards.getByName(body.name).call(body.call)
        : yield* boards.getByName(body.name || ADMISSION_OBJECT_NAME).admit(body.admit)
      return HttpServerResponse.text(reply, { headers: { 'content-type': 'application/json' } })
    }),
  }
}).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding))) {}
