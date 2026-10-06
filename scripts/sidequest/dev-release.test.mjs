import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertCheckout, censusOf, validateCensus } from './dev-release.mjs'
import { testnetOperation } from './transaction.mjs'

const infra = JSON.parse(readFileSync(new URL('../../infra/dev.json', import.meta.url), 'utf8'))
const fresh = () => ({ zone: { id: infra.cloudflare.zoneId, account: { id: infra.cloudflare.accountId }, name: infra.cloudflare.zoneName, status: 'active' }, workers: [], databases: [], buckets: [], domains: [] })

test('release refuses source edits while permitting neighbours outside its committed export', () => {
  const clean = { branch: 'main', staged: [], dirty: [], unknown: [] }
  assertCheckout(clean)
  assertCheckout({ ...clean, dirty: ['apps/indexer/src/worker.ts'], unknown: ['.artifact-video/take.png'] })
  for (const input of [{ ...clean, branch: 'other' }, { ...clean, staged: ['apps/api/src/worker.ts'] }, { ...clean, dirty: ['apps/api/src/worker.ts'] }, { ...clean, unknown: ['scripts/unknown.mjs'] }]) assert.throws(() => assertCheckout(input))
})

test('fresh resource collision or foreign zone refuses before provider mutation', () => {
  assert.equal(validateCensus(infra, fresh(), null), 'create')
  for (const census of [
    { ...fresh(), workers: [{ id: infra.resources.Api }] },
    { ...fresh(), databases: [{ name: infra.resources.Database }] },
    { ...fresh(), buckets: [{ name: infra.resources.Manifests }] },
    { ...fresh(), domains: [{ hostname: new URL(infra.origin).hostname }] },
    { ...fresh(), zone: { ...fresh().zone, account: { id: 'other-account' } } },
  ]) assert.throws(() => validateCensus(infra, census, null))
})

test('updates require exact state, storage, Worker tags and canonical domain ownership', () => {
  const state = Object.fromEntries(Object.keys(infra.resources).map(id => [id, { logicalId: id, providerMode: 'live', status: 'created', attr: { accountId: infra.cloudflare.accountId, workerName: infra.resources[id], databaseName: infra.resources[id], bucketName: infra.resources[id], databaseId: 'db-id' } }]))
  const census = { ...fresh(), workers: ['Api', 'Indexer', 'Explore'].map(id => ({ id: infra.resources[id], tags: ['alchemy:stack:Sidequest', 'alchemy:stage:dev'] })), databases: [{ name: infra.resources.Database, uuid: 'db-id' }], buckets: [{ name: infra.resources.Manifests }], domains: [{ hostname: new URL(infra.origin).hostname, service: infra.resources.Explore, zone_id: infra.cloudflare.zoneId }] }
  assert.equal(validateCensus(infra, census, state), 'update')
  assert.throws(() => validateCensus(infra, census, { ...state, Api: undefined }))
  assert.throws(() => validateCensus(infra, { ...census, workers: census.workers.map(worker => ({ ...worker, tags: [] })) }, state))
  assert.throws(() => validateCensus(infra, { ...census, domains: [{ ...census.domains[0], service: 'foreign-worker' }] }, state))
  assert.throws(() => validateCensus(infra, { ...census, databases: [{ name: infra.resources.Database, uuid: 'foreign-db' }] }, state))
})

test('census traverses domain and D1 pagination and rejects missing page metadata', async () => {
  let requests = 0
  const fetcher = async url => {
    requests++
    const parsed = new URL(url), page = Number(parsed.searchParams.get('page'))
    const result = parsed.pathname.includes('/zones/') ? fresh().zone : parsed.pathname.endsWith('/r2/buckets') ? { buckets: [] } : parsed.pathname.endsWith('/workers/scripts') ? [] : []
    return Response.json({ success: true, result, ...(page ? { result_info: { page, total_pages: 2 } } : {}) })
  }
  const result = await censusOf(infra, 'test-token', fetcher)
  assert.equal(requests, 7)
  assert.equal(result.zone.id, infra.cloudflare.zoneId)
  await assert.rejects(censusOf(infra, 'test-token', async () => Response.json({ success: true, result: [] })), /pagination-incomplete|census-incomplete/)
})

test('testnet sends require explicit enablement before keys or network are accessed', async () => {
  await assert.rejects(testnetOperation({ id: 'unit-refused', key: 'unused', to: 'unused', env: {} }), /testnet-send-not-enabled/)
})

const countPaginationFetcher = truncated => async url => {
    const parsed = new URL(url), page = Number(parsed.searchParams.get('page'))
    if (!page) return Response.json({ success: true, result: parsed.pathname.includes('/zones/') ? fresh().zone : parsed.pathname.endsWith('/r2/buckets') ? { buckets: [] } : [] })
    const result = Array.from({ length: page === 1 ? 100 : truncated ? 0 : 1 }, (_, i) => ({ id: (page - 1) * 100 + i }))
    return Response.json({ success: true, result, result_info: { page, per_page: 100, count: result.length, total_count: 101 } })
}

test('Cloudflare count-based pagination traverses every row and refuses incomplete totals', async () => {
  const census = await censusOf(infra, 'test-token', countPaginationFetcher(false))
  assert.equal(census.databases.length, 101)
  assert.equal(census.domains.length, 101)
  await assert.rejects(censusOf(infra, 'test-token', countPaginationFetcher(true)), /pagination-incomplete/)
})
