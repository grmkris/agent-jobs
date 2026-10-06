import { DatabaseSync } from 'node:sqlite'
import { fromNodeSqlite } from '@sidequest/indexer'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import { recordIndexerRun } from './run-record.ts'

const fixtures = [
  new Error('Authorization: Bearer SECRETKEY'),
  Object.assign(new TypeError('upstream refused {apiKey:short}'), { code: 'rate-limited', status: 429, body: '{"apiKey":"sk-1"}', details: 'x-api-key: ab12', cause: new Error('Bearer SECRETKEY') }),
  'Authorization: Bearer SECRETKEY {apiKey:short}',
]

async function record(cause: Cause.Cause<unknown>) {
  const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
  await recordIndexerRun(sql, { ok: false, cause }, 123)
  const [row] = await sql.all<{ at: number; ok: number; detail: string }>('SELECT at, ok, detail FROM indexer_runs')
  expect(row).toMatchObject({ at: 123, ok: 0 })
  expect(row!.detail).not.toMatch(/Authorization|Bearer|SECRETKEY|apiKey|short|sk-1|ab12|x-api-key|upstream|refused/)
  return JSON.parse(row!.detail)
}

describe('public indexer run records', () => {
  it.each(fixtures.map((_, index) => index))('records typed failure %s without message, body, details or cause text', async (index) => {
    expect(await record(Cause.fail(fixtures[index]))).toEqual({
      failures: 1, defects: 0, interruptions: 0,
      errors: [{ name: ['Error', 'TypeError', 'string'][index], ...(index === 1 ? { code: 'rate-limited', status: 429 } : {}) }],
    })
  })

  it.each(fixtures.map((_, index) => index))('records Effect.promise rejection %s without credential text', async (index) => {
    const details = await Effect.runPromise(
      Effect.promise(() => Promise.reject(fixtures[index])).pipe(Effect.catchCause(cause => Effect.promise(() => record(cause)))),
    )
    expect(details).toEqual({ failures: 0, defects: 1, interruptions: 0, errors: [{ name: ['Error', 'TypeError', 'string'][index], ...(index === 1 ? { code: 'rate-limited', status: 429 } : {}) }] })
  })

  it('counts every cause kind while keeping only static diagnostics', async () => {
    const cause = Cause.fromReasons([
      Cause.makeFailReason(fixtures[0]), Cause.makeFailReason(fixtures[1]),
      Cause.makeDieReason(fixtures[2]), Cause.makeInterruptReason(42),
    ])
    expect(await record(cause)).toEqual({ failures: 2, defects: 1, interruptions: 1, errors: [{ name: 'Error' }, { name: 'TypeError', code: 'rate-limited', status: 429 }, { name: 'string' }] })
  })

  it('bounds a large failure record without truncating its JSON or counts', async () => {
    const cause = Cause.fromReasons(Array.from({ length: 20 }, () => Cause.makeFailReason(Object.assign(new Error('Bearer SECRETKEY'), { name: 'E'.repeat(64), code: 'c'.repeat(32), status: 429 }))))
    const details = await record(cause)
    expect(details).toMatchObject({ failures: 20, defects: 0, interruptions: 0 })
    expect(details.errors).toHaveLength(8)
    expect(JSON.stringify(details).length).toBeLessThan(2000)
  })

  it('preserves numeric run summaries and skipped/lease outcomes', async () => {
    const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
    const summary = { lease: true, pages: 5, events: 12, protocolEvents: 3, jobs: 2, nextBlock: 456, rewound: false, backfilled: 8 }
    const results = [summary, { ...summary, lease: false, pages: 0, nextBlock: null }, { skipped: 'HYPERSYNC_API_TOKEN or MONAD_RPC_URL unset' }]
    for (const result of results) {
      await recordIndexerRun(sql, { ok: true, result }, 456)
      expect(await sql.all('SELECT at, ok, detail FROM indexer_runs')).toEqual([{ at: 456, ok: 1, detail: JSON.stringify(result) }])
    }
  })
})
