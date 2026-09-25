import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import Board from './board.ts'
import { Database } from './database.ts'
import { Manifests } from './manifests.ts'

/**
 * The hosted board service (spec §5). S0 exposes three probes so the harness can prove each
 * binding works in local workerd: `/health` (runtime), `/boards/:id/tasks` (Durable Object),
 * `/manifests/:key` (R2 put/get) and `/db` (D1 query).
 */
export default class Api extends Cloudflare.Worker<Api>()(
  'Api',
  {
    main: import.meta.url,
    compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
    dev: { port: 8788 },
  },
  Effect.gen(function* () {
    const boards = yield* Board
    const db = yield* Cloudflare.D1.QueryDatabase(Database)
    const manifests = yield* Cloudflare.R2.ReadWriteBucket(Manifests)

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, 'http://board')
        const [, head, id, tail] = url.pathname.split('/')

        if (head === 'health') {
          return HttpServerResponse.jsonUnsafe({ ok: true, runtime: navigator.userAgent })
        }

        if (head === 'boards' && id && tail === 'tasks') {
          const board = boards.getByName(id)
          if (request.method === 'POST') {
            const count = yield* board.createTask()
            return HttpServerResponse.jsonUnsafe({ boardId: id, tasks: count })
          }
          const count = yield* board.taskCount()
          return HttpServerResponse.jsonUnsafe({ boardId: id, tasks: count })
        }

        if (head === 'manifests' && id) {
          if (request.method === 'PUT') {
            const body = yield* request.text
            yield* manifests.put(id, body)
            return HttpServerResponse.empty({ status: 201 })
          }
          const object = yield* manifests.get(id)
          if (object === null) return HttpServerResponse.text('not found', { status: 404 })
          return HttpServerResponse.text(yield* object.text())
        }

        if (head === 'db') {
          const row = yield* db.prepare('SELECT 1 AS one').first<{ one: number }>()
          return HttpServerResponse.jsonUnsafe({ one: row?.one ?? null })
        }

        return HttpServerResponse.text('not found', { status: 404 })
      }).pipe(Effect.orDie),
    }
  }).pipe(
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
    Effect.provide(Cloudflare.R2.ReadWriteBucketBinding),
  ),
) {}
