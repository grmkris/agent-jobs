import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import { cloudflarePaged } from './cloudflare.mjs'
import { StagingReleaseError, reportReleaseFailure, runStagingEffect } from './errors.mjs'

test('release catch reports a real census code and hides an arbitrary provider error', async () => {
  const originalFetch = globalThis.fetch
  const lines = []
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, result: [], result_info: {} }))
  try {
    try { await cloudflarePaged('/test-list') } catch (error) { reportReleaseFailure(error, line => lines.push(line)) }
    reportReleaseFailure(new Error('private provider request body'), line => lines.push(line))
    assert.deepEqual(lines, ['Staging release stopped: census-pagination-metadata-missing', 'Staging release stopped. Read back Cloudflare versions and the private release journal before retrying.'])
  } finally { globalThis.fetch = originalFetch }
})

test('only allowlisted codes in our error type may be rendered', () => {
  assert.throws(() => new StagingReleaseError('private-value'), /Invalid staging release error code/)
  assert.throws(() => new StagingReleaseError('guard-artifact-store-missing', 'private-value'), /Invalid staging logical id/)
  const lines = []
  reportReleaseFailure({ code: 'census-page-short', message: 'provider value' }, line => lines.push(line))
  assert.deepEqual(lines, ['Staging release stopped. Read back Cloudflare versions and the private release journal before retrying.'])
})

test('artifact diagnostics render only the fixed worker logical ids', () => {
  const lines = []
  for (const id of ['Api', 'Indexer', 'Explore']) reportReleaseFailure(new StagingReleaseError('guard-artifact-build-missing', id), line => lines.push(line))
  assert.deepEqual(lines, ['Api', 'Indexer', 'Explore'].map(id => `Staging release stopped: guard-artifact-build-missing(${id})`))
})

test('Effect preserves allowlisted guard/census codes through both failure and defect wrappers', async () => {
  for (const effect of [Effect.fail(new StagingReleaseError('guard-plan-protection-failed')),
    Effect.sync(() => { throw new StagingReleaseError('census-page-short') })]) {
    await assert.rejects(runStagingEffect(effect), StagingReleaseError)
  }
  assert.equal(await runStagingEffect(Effect.succeed('ok')), 'ok')
  const lines = []
  try { await runStagingEffect(Effect.fail(new Error('private provider value'))) }
  catch (error) { reportReleaseFailure(error, line => lines.push(line)) }
  assert.deepEqual(lines, ['Staging release stopped. Read back Cloudflare versions and the private release journal before retrying.'])
})
