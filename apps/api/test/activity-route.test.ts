import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { activityRoute } from '../src/worker.ts'
import { activityFixture } from './activity-fixture.ts'

let fixture: Awaited<ReturnType<typeof activityFixture>>
beforeAll(async () => {
  fixture = await activityFixture()
  await fixture.addJob([fixture.published('1', 10)], 'public')
  await fixture.addJob([fixture.published('2', 20)], 'my-team')
  await fixture.addJob([fixture.published('3', 30)], null)
})
afterAll(() => fixture.db.close())

/** The API's anonymous data-route handler against the production fold and real SQLite. */
async function get(path: string, boardId = 'public') {
  return HttpServerResponse.toWeb(
    await activityRoute(fixture.sql, fixture.deployment, new URL(path, 'https://test.invalid'), boardId, {
      'access-control-allow-origin': 'https://test.invalid',
    }),
  )
}

it('serves and pages /data/activity anonymously through the API route handler', async () => {
  const first = await get('/data/activity?limit=2')
  expect(first.status).toBe(200)
  expect(first.headers.get('access-control-allow-origin')).toBe('https://test.invalid')
  // SAFETY: the production route serializes the explicitly typed page from recentJobSteps.
  const page = (await first.json()) as { ok: boolean; steps: Array<{ jobId: string }>; nextCursor: string }
  expect(Object.keys(page).toSorted()).toEqual(['nextCursor', 'ok', 'steps'])
  expect(page.ok).toBe(true)
  expect(page.steps.map((r) => r.jobId)).toEqual(['3', '2'])
  const second = await get(`/data/activity?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`)
  expect(second.status).toBe(200)
  expect(await second.json()).toMatchObject({ ok: true, steps: [{ jobId: '1' }], nextCursor: null })
})

it('scopes the routed tenant board like jobs and supports the explicit board filter', async () => {
  const tenant = await get('/b/my-team/data/activity', 'my-team')
  expect(await tenant.json()).toMatchObject({ ok: true, steps: [{ jobId: '2', boardId: 'my-team' }], nextCursor: null })
  expect(await (await get('/data/activity?board=my-team')).json()).toMatchObject({
    ok: true,
    steps: [{ jobId: '2', boardId: 'my-team' }],
    nextCursor: null,
  })
  expect(await (await get('/b/my-team/data/activity?board=public', 'my-team')).json()).toMatchObject({
    ok: true,
    steps: [{ jobId: '1', boardId: 'public' }],
  })
})

it('returns the invalid-parameter envelope and HTTP 400 without requiring a session', async () => {
  for (const query of [
    'limit=0',
    'limit=51',
    'limit=1.5',
    'limit=abc',
    'limit=',
    'cursor=bad',
    'cursor=',
    'board=',
    'board=Bad',
  ]) {
    const response = await get(`/data/activity?${query}`)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, code: 'invalid', message: expect.any(String) })
  }
})

it('returns unavailable when the index has not been built yet', async () => {
  const sql = {
    all: async () => {
      throw new Error('no such table: events')
    },
    batch: async () => {
      throw new Error('activity must not write')
    },
  }
  const response = HttpServerResponse.toWeb(
    await activityRoute(sql, fixture.deployment, new URL('https://test.invalid/data/activity'), 'public', {}),
  )
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ ok: false, code: 'unavailable', message: 'the index is not built yet' })
})
