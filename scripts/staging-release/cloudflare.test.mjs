import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudflarePaged, liveBuckets, liveNamespaces } from './cloudflare.mjs'

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

test('pagination fails closed when a page is short before total_count', async () => {
  globalThis.fetch = async () => response({ result: [{ id: 'first', class: 'Other', script: 'other' }], result_info: { count: 1, page: 1, per_page: 2, total_count: 5 } })
  try { await assert.rejects(liveNamespaces(), /page ended before total_count/) }
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
    try { await assert.rejects(cloudflarePaged('/test-list'), /Cloudflare list/) }
    finally { globalThis.fetch = originalFetch }
  }
})

test('pagination refuses a total_count change between pages', async () => {
  let page = 0
  globalThis.fetch = async () => response({ result: [{ id: `item-${++page}` }], result_info: { page, per_page: 1, total_count: page === 1 ? 3 : 4 } })
  try { await assert.rejects(cloudflarePaged('/test-list'), /total changed/) }
  finally { globalThis.fetch = originalFetch }
})

test('namespace census refuses repeated identities even when raw page counts add up', async () => {
  let page = 0
  globalThis.fetch = async () => response({ result: [{ id: 'repeated', class: 'Other', script: 'other' }], result_info: { page: ++page, per_page: 1, total_count: 2 } })
  try { await assert.rejects(liveNamespaces(), /duplicate identities/) }
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
  try { await assert.rejects(liveBuckets(1), /page did not advance/) }
  finally { globalThis.fetch = originalFetch }
})
