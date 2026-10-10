import { DatabaseSync } from 'node:sqlite'
import { fromNodeSqlite, migrate, stmt } from '@sidequest/indexer'
import * as sdk from '@sidequest/sdk'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { afterEach, expect, it } from 'vitest'
import { backerShareRoute } from '../src/backer-share.ts'

const base = sdk.deployment('monad-testnet')
const deployment = { ...base, deployBlock: 100n, sidequest: { ...base.sidequest!, block: 100n } }
const h = deployment.sidequest
const clocks = sdk.configuredClocks(deployment)
const dbs: DatabaseSync[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

async function fixture(sets: readonly { at: number; bps: number }[], now: number) {
  const db = new DatabaseSync(':memory:')
  dbs.push(db)
  const sql = fromNodeSqlite(db)
  await migrate(sql)
  await sql.batch([
    stmt(
      'INSERT INTO checkpoint VALUES (?, ?, ?, ?, ?, ?)',
      deployment.chainId,
      200,
      'hash',
      deployment.core.toLowerCase(),
      100,
      now,
    ),
    stmt(
      'INSERT INTO backer_share_checkpoint VALUES (?, ?, ?, ?, ?)',
      deployment.chainId,
      deployment.identity.toLowerCase(),
      100,
      200,
      200,
    ),
    ...sets.flatMap((set, index) => [
      stmt(
        'INSERT INTO protocol_events VALUES (?, ?, ?, ?, ?, ?, ?)',
        deployment.chainId,
        deployment.identity.toLowerCase(),
        101 + index,
        index,
        'tx',
        'MetadataSet',
        JSON.stringify({
          agentId: '7',
          metadataKey: sdk.BACKER_SHARE_KEY,
          metadataValue: sdk.encodeBackerShare(set.bps),
        }),
      ),
      stmt('INSERT INTO block_times VALUES (?, ?, ?)', deployment.chainId, 101 + index, set.at),
    ]),
  ])
  const get = async (id = '7') =>
    HttpServerResponse.toWeb(
      await backerShareRoute(sql, deployment, `/data/backer-share/${id}`, now, { 'access-control-allow-origin': '*' }),
    )
  return { sql, get }
}

it('returns the anonymous current and next schedule for a raise', async () => {
  const { get } = await fixture(
    [
      { at: h.t0 - 1, bps: 1000 },
      { at: h.t0 + 10, bps: 5000 },
    ],
    h.t0 + 20,
  )
  const response = await get()
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('access-control-allow-origin')).toBe('*')
  expect(await response.json()).toEqual({
    ok: true,
    agentId: '7',
    current: { bps: 1000, epoch: 0, since: h.t0 },
    next: { bps: 5000, epoch: 1 },
    pendingCut: null,
    unstakeDelay: clocks.unstakeDelay,
    epochSeconds: clocks.epochDuration,
  })
})
it('reports a cut until the first epoch after its complete unstake window', async () => {
  const at = h.t0 + 10
  const { get } = await fixture(
    [
      { at: h.t0 - 1, bps: 5000 },
      { at, bps: 1000 },
    ],
    at + 20,
  )
  const epoch = 1 + Math.floor((at + clocks.unstakeDelay - h.t0 - clocks.epochZeroDuration) / clocks.epochDuration) + 1
  expect(await (await get()).json()).toMatchObject({
    current: { bps: 5000 },
    next: { bps: 5000 },
    pendingCut: { bps: 1000, appliesFromEpoch: epoch, at },
  })
})
it('clears an applied cut and keeps an unset agent at zero', async () => {
  const { get } = await fixture(
    [
      { at: h.t0 - 1, bps: 5000 },
      { at: h.t0 + 10, bps: 1000 },
    ],
    h.t0 + clocks.unstakeDelay + clocks.epochDuration,
  )
  expect(await (await get()).json()).toMatchObject({ current: { bps: 1000 }, next: { bps: 1000 }, pendingCut: null })
  expect(await (await get('8')).json()).toMatchObject({ agentId: '8', current: { bps: 0 }, pendingCut: null })
})
it.each(['0', '01', '-1', 'bad', '9'.repeat(78)])('rejects an invalid agent ID %s with HTTP 400', async (id) => {
  const { get } = await fixture([], h.t0 + 20)
  expect((await get(id)).status).toBe(400)
})
it.each(['backfill', 'stale', 'timestamp', 'generation'])(
  'refuses incomplete or unavailable %s history',
  async (reason) => {
    const { sql, get } = await fixture([{ at: h.t0 - 1, bps: 5000 }], h.t0 + 20)
    const query = {
      backfill: 'UPDATE backer_share_checkpoint SET next_block=101',
      stale: 'UPDATE checkpoint SET updated_at=0',
      timestamp: 'DELETE FROM block_times',
      generation: 'UPDATE checkpoint SET deployment_block=99',
    }[reason]!
    await sql.batch([stmt(query)])
    const response = await get()
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ ok: false, code: 'unavailable' })
  },
)
