import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudflarePaged, liveBuckets, liveDeployment, liveDomains, liveNamespaces } from './cloudflare.mjs'

const originalFetch = globalThis.fetch
const response = body => new Response(JSON.stringify({ success: true, ...body }), { headers: { 'content-type': 'application/json' } })

test('liveNamespaces reads every page when total_pages is absent', async () => {
  const calls = []
  globalThis.fetch = async url => {
    const page = Number(new URL(url).searchParams.get('page'))
    calls.push(page)
    const rows = [[{ id: 'first', class: 'Other', script: 'other' }], [{ id: 'second', class: 'Other', script: 'other' }], [{ id: 'directory', class: 'DirectoryObject', script: 'agentjobs-api-staging-ba2zqmaom6el4lws' }]][page - 1] ?? []
    return response({ result: rows, result_info: { count: rows.length, page, per_page: 1, total_count: 3 } })
  }
  try {
    assert.deepEqual(await liveNamespaces(), [{ id: 'directory', className: 'DirectoryObject', script: 'agentjobs-api-staging-ba2zqmaom6el4lws' }])
    assert.deepEqual(calls, [1, 2, 3])
  } finally { globalThis.fetch = originalFetch }
})

test('domain census traverses later pages before filtering Hireling domains', async () => {
  const calls = []
  const target = { hostname: 'testnet.hireling.xyz', service: 'fixture-script', zone_id: 'fixture-zone' }
  globalThis.fetch = async url => {
    const page = Number(new URL(url).searchParams.get('page'))
    assert.equal(new URL(url).pathname.endsWith('/workers/domains'), true)
    calls.push(page)
    return response({ result: [page === 3 ? target : { hostname: `other-${page}.example` }], result_info: { page, per_page: 1, count: 1, total_count: 3 } })
  }
  try {
    assert.deepEqual(await liveDomains(), [target])
    assert.deepEqual(calls, [1, 2, 3])
  } finally { globalThis.fetch = originalFetch }
})

test('domain census refuses missing metadata and a changed total on a later page', async () => {
  for (const missing of [true, false]) {
    globalThis.fetch = async url => {
      const page = Number(new URL(url).searchParams.get('page'))
      return response({ result: [{ hostname: 'other.example' }], result_info: missing ? undefined : { page, per_page: 1, count: 1, total_count: page === 1 ? 3 : 4 } })
    }
    try { await assert.rejects(liveDomains(), { message: missing ? 'census-pagination-metadata-missing' : 'census-total-changed' }) }
    finally { globalThis.fetch = originalFetch }
  }
})

test('pagination fails closed when a page is short before total_count', async () => {
  globalThis.fetch = async () => response({ result: [{ id: 'first', class: 'Other', script: 'other' }], result_info: { count: 1, page: 1, per_page: 2, total_count: 5 } })
  try { await assert.rejects(liveNamespaces(), /census-page-short/) }
  finally { globalThis.fetch = originalFetch }
})

test('pagination refuses wrong pages, totals, counts, missing metadata and overfull pages', async () => {
  for (const body of [
    { result: [], result_info: { page: 2, per_page: 2, total_count: 0 } },
    { result: [{ id: 'first' }], result_info: { page: 1, per_page: 2, total_count: 0 } },
    { result: [{ id: 'first' }], result_info: { page: 1, per_page: 1, total_count: 1, count: 2 } },
    { result: [], result_info: { page: 1, per_page: 2 } },
    { result: [{ id: 'first' }, { id: 'second' }], result_info: { page: 1, per_page: 1, total_count: 2 } },
  ]) {
    globalThis.fetch = async () => response(body)
    try { await assert.rejects(cloudflarePaged('/test-list'), /census-/) }
    finally { globalThis.fetch = originalFetch }
  }
})

test('pagination refuses a total_count change between pages', async () => {
  let page = 0
  globalThis.fetch = async () => response({ result: [{ id: `item-${++page}` }], result_info: { page, per_page: 1, total_count: page === 1 ? 3 : 4 } })
  try { await assert.rejects(cloudflarePaged('/test-list'), /census-total-changed/) }
  finally { globalThis.fetch = originalFetch }
})

test('namespace census refuses repeated identities even when raw page counts add up', async () => {
  let page = 0
  globalThis.fetch = async () => response({ result: [{ id: 'repeated', class: 'Other', script: 'other' }], result_info: { page: ++page, per_page: 1, total_count: 2 } })
  try { await assert.rejects(liveNamespaces(), /census-namespace-identities-invalid/) }
  finally { globalThis.fetch = originalFetch }
})

test('R2 bucket census follows start_after to the final short page without pagination metadata', async () => {
  const starts = []
  globalThis.fetch = async url => {
    const after = new URL(url).searchParams.get('start_after')
    starts.push(after)
    return response({ result: { buckets: (after === null ? ['a', 'b'] : ['c']).map(name => ({ name })) } })
  }
  try {
    assert.deepEqual((await liveBuckets(2)).map(bucket => bucket.name), ['a', 'b', 'c'])
    assert.deepEqual(starts, [null, 'b'])
  } finally { globalThis.fetch = originalFetch }
})

test('R2 refuses repeated or malformed pages rather than silently omitting later buckets', async () => {
  globalThis.fetch = async () => response({ result: { buckets: [{ name: 'a' }] } })
  try { await assert.rejects(liveBuckets(1), /census-bucket-page-not-advancing/) }
  finally { globalThis.fetch = originalFetch }
})


const deployment = (day, version = `version-${day}`) => ({ id: `deployment-${day}-${version}`, created_on: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`, versions: [{ version_id: version, percentage: 100 }] })
const deploymentPages = rows => async url => {
  const page = Number(new URL(url).searchParams.get('page'))
  const deployments = rows.slice((page - 1) * 2, page * 2)
  return response({ result: { deployments }, result_info: { page, per_page: 2, total_count: rows.length, count: deployments.length } })
}

test('deployments across three pages select the unique newest created_on', async () => {
  const rows = [5, 4, 3, 2, 1].map(day => deployment(day))
  const pages = []
  globalThis.fetch = async url => {
    pages.push(Number(new URL(url).searchParams.get('page')))
    return deploymentPages(rows)(url)
  }
  try {
    assert.deepEqual(await liveDeployment('test-script'), rows[0])
    assert.deepEqual(pages, [1, 2, 3])
  } finally { globalThis.fetch = originalFetch }
})

test('deployment history refuses a newer later page and any disagreement with newest-first order', async () => {
  for (const days of [[4, 3, 5, 2, 1], [5, 3, 4, 2, 1]]) {
    globalThis.fetch = deploymentPages(days.map(day => deployment(day)))
    try { await assert.rejects(liveDeployment('test-script'), /census-deployment-order-invalid/) }
    finally { globalThis.fetch = originalFetch }
  }
})

test('deployment history refuses an ambiguous newest timestamp, missing/invalid dates and split traffic', async () => {
  for (const [rows, code] of [
    [[deployment(5), deployment(5, 'another-version')], 'census-deployment-newest-ambiguous'],
    [[deployment(5), { ...deployment(4), created_on: undefined }], 'census-deployment-timestamp-invalid'],
    [[deployment(5), { ...deployment(4), created_on: 'unparsable' }], 'census-deployment-timestamp-invalid'],
    [[{ ...deployment(5), versions: [{ version_id: 'a', percentage: 50 }, { version_id: 'b', percentage: 50 }] }], 'census-deployment-traffic-invalid'],
    [[{ ...deployment(5), versions: [{ version_id: 'a', percentage: 99 }] }], 'census-deployment-traffic-invalid'],
  ]) {
    globalThis.fetch = deploymentPages(rows)
    try { await assert.rejects(liveDeployment('test-script'), { message: code }) }
    finally { globalThis.fetch = originalFetch }
  }
})

test('deployment history refuses duplicate and missing ids across the complete history', async () => {
  for (const rows of [
    [deployment(5), deployment(4), deployment(3), { ...deployment(2), id: deployment(4).id }],
    [deployment(5), { ...deployment(4), id: undefined }],
    [deployment(5), { ...deployment(4), id: '' }],
  ]) {
    globalThis.fetch = deploymentPages(rows)
    try { await assert.rejects(liveDeployment('test-script'), { message: 'census-deployment-identities-invalid' }) }
    finally { globalThis.fetch = originalFetch }
  }
})

test('deployment history refuses equal older timestamps across a page boundary', async () => {
  globalThis.fetch = deploymentPages([deployment(5), deployment(4), deployment(4, 'different-version'), deployment(2), deployment(1)])
  try { await assert.rejects(liveDeployment('test-script'), { message: 'census-deployment-order-invalid' }) }
  finally { globalThis.fetch = originalFetch }
})

test('agent signing census requires a secret routine key and nonempty plain identifiers after release', async () => {
  const { validateCensus } = await import('./cloudflare.mjs')
  const { expected } = await import('./evidence.mjs')
  const bindings = [
    { name: 'Database', id: expected.resources.Database },
    { name: 'Manifests', bucket_name: expected.resources.Manifests },
    { name: 'Board', namespace_id: expected.boardNamespace },
    ...['AI_GATEWAY_API_KEY', 'ATTESTER_PRIVATE_KEY', 'RELAY_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY', 'BUDGET_SIGNER_PRIVATE_KEY', 'PRIVY_APP_SECRET'].map(name => ({ name, type: 'secret_text' })),
  ]
  const live = {
    databaseId: expected.resources.Database, bucketName: expected.resources.Manifests,
    domains: expected.domains.map(hostname => ({ hostname, service: expected.resources.Explore, zone_id: 'd4ad1574270cad47f2e33381dba31f84' })),
    namespaces: [{ id: expected.boardNamespace, className: 'Board' }],
    workers: Object.fromEntries(['Api', 'Indexer', 'Explore'].map(id => [id, { name: expected.resources[id], tags: ['alchemy:stack:AgentJobs', 'alchemy:stage:staging'], crons: id === 'Indexer' ? ['* * * * *'] : [], bindings: id === 'Api' ? bindings : id === 'Indexer' ? [{ name: 'Database', id: expected.resources.Database }] : [{ name: 'API', service: expected.resources.Api }] }])),
  }
  validateCensus(live)
  assert.throws(() => validateCensus(live, { requireAgentSigning: true }), /census-agent-signer-binding-missing/)
  bindings.push({ name: 'PRIVY_SIGNER_KEY', type: 'secret_text' })
  assert.throws(() => validateCensus(live, { requireAgentSigning: true }), /census-agent-authority-setting-missing/)
  for (const name of ['PRIVY_APP_ID', 'PRIVY_SIGNER_ID', 'PRIVY_POLICY_ID']) bindings.push({ name, type: 'plain_text', text: 'public-id' })
  validateCensus(live, { requireAgentSigning: true })
  bindings.find(binding => binding.name === 'PRIVY_SIGNER_KEY').type = 'plain_text'
  assert.throws(() => validateCensus(live, { requireAgentSigning: true }), /census-agent-signer-binding-missing/)
})
