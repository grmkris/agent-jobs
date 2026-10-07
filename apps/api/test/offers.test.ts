import { expect, it } from 'vitest'
import { offerResponse } from '../src/offers.ts'

it('serves content-addressed offers with wildcard CORS and a year of immutable caching', () => {
  const response = offerResponse('{"title":"frozen"}')
  expect(response.status).toBe(200)
  expect(response.headers['access-control-allow-origin']).toBe('*')
  expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  expect(response.headers['content-type']).toBe('application/json')
})

it('allows cross-origin callers to read a missing offer without caching the miss forever', () => {
  const response = offerResponse(null)
  expect(response.status).toBe(404)
  expect(response.headers['access-control-allow-origin']).toBe('*')
  expect(response.headers['cache-control']).toBeUndefined()
})
