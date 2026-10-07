import { expect, it } from 'vitest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { backingOf, positionIn } from '@sidequest/sdk'
import { jsonResponse } from '../src/json.ts'

it('VV2-005 encodes empty delegation lists and nested backing/position bigints through the actual Worker response constructor', async () => {
  const blockNumber = 99n
  const empty = HttpServerResponse.toWeb(jsonResponse({ ok: true, blockNumber, positions: [] }))
  expect(await empty.json()).toEqual({ ok: true, blockNumber: '99', positions: [] })
  const shares = (1n << 192n) - 1n
  const pool = { assets: 10n ** 30n, reserved: 2n, shares, queuedShares: 0n, generation: 1n }
  const backing = backingOf(pool, { thresholds: [0n], bps: [3000] })
  const position = positionIn(pool, { shares, queuedShares: 0n, generation: 1n, unlockAt: 0 })
  const response = HttpServerResponse.toWeb(
    jsonResponse(
      { ok: true, blockNumber, ...backing, position },
      {
        status: 200,
        headers: { 'access-control-allow-origin': 'https://sidequest.example' },
      },
    ),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('access-control-allow-origin')).toBe('https://sidequest.example')
  expect(await response.json()).toMatchObject({
    blockNumber: '99',
    assets: pool.assets.toString(),
    shares: shares.toString(),
    tier: { threshold: '0', needed: '0', nextThreshold: null },
    position: { value: pool.assets.toString(), queued: '0', unlockAt: 0, staleGeneration: false },
  })
})
