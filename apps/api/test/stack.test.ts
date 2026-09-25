import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import * as HttpBody from 'effect/unstable/http/HttpBody'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import { expect } from 'vitest'
import Stack from '../../../alchemy.run.ts'

/**
 * Deploys the stack into local workerd (`dev: true`) and probes every binding through the Worker.
 * Runs without Cloudflare credentials: every resource here has a local provider.
 */
const { test, beforeAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  dev: true,
})

const stack = beforeAll(deploy(Stack))
// No `destroy`: the stack is local (`.alchemy/` is gitignored, CI runners are ephemeral) and
// destroying a local stack hangs the harness in alchemy 2.0.0-beta.79. Persisting it also makes
// reruns fast, so every test below must be independent of what earlier runs left behind.

/** A board id no earlier run has touched. */
const freshBoardId = () => `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

test('the worker answers from workerd',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const response = yield* HttpClient.get(`${apiUrl}/health`)
    const body = (yield* response.json) as { ok: boolean; runtime: string }
    expect(body.ok).toBe(true)
    // The same probe cloudflare-os uses: workerd hardcodes this user agent, Node never does.
    expect(body.runtime).toBe('Cloudflare-Workers')
  }))

test('a board Durable Object keeps its count across requests',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const boardId = freshBoardId()
    const otherId = freshBoardId()
    const first = yield* HttpClient.post(`${apiUrl}/boards/${boardId}/tasks`)
    expect((yield* first.json) as unknown).toEqual({ boardId, tasks: 1 })
    yield* HttpClient.post(`${apiUrl}/boards/${boardId}/tasks`)
    const read = yield* HttpClient.get(`${apiUrl}/boards/${boardId}/tasks`)
    expect((yield* read.json) as unknown).toEqual({ boardId, tasks: 2 })
    const other = yield* HttpClient.get(`${apiUrl}/boards/${otherId}/tasks`)
    expect((yield* other.json) as unknown).toEqual({ boardId: otherId, tasks: 0 })
  }))

test('manifests round-trip through R2',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const key = `${freshBoardId()}.json`
    const put = yield* HttpClient.put(`${apiUrl}/manifests/${key}`, {
      body: HttpBody.text('{"v":1}'),
    })
    expect(put.status).toBe(201)
    const get = yield* HttpClient.get(`${apiUrl}/manifests/${key}`)
    expect(yield* get.text).toBe('{"v":1}')
    const missing = yield* HttpClient.get(`${apiUrl}/manifests/nope`)
    expect(missing.status).toBe(404)
  }))

test('D1 answers a query',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const response = yield* HttpClient.get(`${apiUrl}/db`)
    expect((yield* response.json) as unknown).toEqual({ one: 1 })
  }))
