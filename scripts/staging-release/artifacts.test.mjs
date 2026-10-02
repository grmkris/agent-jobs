import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import { NodeServices } from '@effect/platform-node'
import { ArtifactStore, Artifacts, cached, createArtifactStore, makeScopedArtifacts } from 'alchemy/Artifacts'
import { prepareArtifacts, providerBundle, storedBundle } from './artifacts.mjs'
import { artifactOf, viteArtifact } from './payload.mjs'
import { reportReleaseFailure, runStagingEffect } from './errors.mjs'

const key = Buffer.alloc(32, 7)
const node = (id, props = {}, action = 'update') => ({
  resource: { LogicalId: id, FQN: `nested/${id}` }, props, action,
  provider: { diff: () => { throw new Error('diff must not be forced') } },
})
const snapshotOf = (context, api, indexer = node('Indexer', {}, 'noop'), explore = node('Explore', {}, 'noop')) => ({
  session: { context }, native: { resources: Object.fromEntries([api, indexer, explore].map(n => [n.resource.FQN, n])) },
})
const prepare = (store, api, options = {}, indexer, explore) => runStagingEffect(Effect.gen(function* () {
  const context = yield* Effect.context()
  return yield* prepareArtifacts(snapshotOf(context, api, indexer, explore), key, options)
}).pipe(Effect.provideService(ArtifactStore, store), Effect.provide(NodeServices.layer)))

test('prepareArtifacts reads the provider-shaped FQN bag populated by cached(build)', async () => {
  const store = createArtifactStore()
  const api = node('Api', { main: 'must-not-rebuild.js', isExternal: true })
  const build = { files: [{ path: 'main.js', content: 'exact reviewed upload bytes' }, { path: 'asset.wasm', content: new Uint8Array([1, 2, 3]) }], hash: 'provider-hash' }
  // Exactly Plan.providePlanScope -> WorkerProvider.prepareBundle -> Artifacts.cached("build").
  await Effect.runPromise(Effect.succeed(build).pipe(cached('build'), Effect.provideService(Artifacts, makeScopedArtifacts(store, api.resource.FQN))))
  makeScopedArtifacts(store, 'Api')
  store.get('Api').set('build', { files: [{ path: 'wrong.js', content: 'other bag' }] })
  const artifacts = await prepare(store, api)
  assert.deepEqual(artifacts.Api, await artifactOf(build))
  assert.equal(store.get(api.resource.FQN).get('build'), build)
  assert.deepEqual(artifacts.Indexer, { kind: 'unchanged' })
})

test('metadata-only update explicitly builds and apply reuses the exact pinned bundle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hireling-artifacts-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
    const main = join(dir, 'worker.js')
    writeFileSync(main, 'export default { fetch() { return new Response("first"); } };')
    const store = createArtifactStore()
    const api = node('Api', { main, isExternal: true, compatibility: { date: '2026-09-01' } })
    const artifacts = await prepare(store, api)
    const built = store.get(api.resource.FQN).get('build')
    assert.ok(built.files.length > 0)
    assert.deepEqual(artifacts.Api, await artifactOf(built))
    writeFileSync(main, 'export default { fetch() { return new Response("changed"); } };')
    // Apply.provideLifecycleScope -> the same prepareBundle options and cache. No second build is allowed.
    const applied = await Effect.runPromise(providerBundle('Api', api.props).pipe(
      Effect.provideService(Artifacts, makeScopedArtifacts(store, api.resource.FQN)), Effect.provide(NodeServices.layer),
    ))
    assert.equal(applied, built)
    assert.deepEqual(await artifactOf(applied), artifacts.Api)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('storedBundle resolves the in-flight Effect value used by the provider cache', async () => {
  const store = createArtifactStore()
  const build = { files: [{ path: 'main.js', content: 'provider bytes' }] }
  makeScopedArtifacts(store, 'nested/Indexer')
  store.get('nested/Indexer').set('build', Effect.succeed(build))
  const result = await runStagingEffect(Effect.gen(function* () { return yield* storedBundle(store, 'nested/Indexer', 'Indexer') }))
  assert.equal(result, build)
})

test('missing bag and missing build report different value-free labels with an allowlisted logical id', async () => {
  for (const [id, present, code] of [['Api', false, 'guard-artifact-store-missing'], ['Indexer', true, 'guard-artifact-build-missing']]) {
    const store = createArtifactStore()
    if (present) makeScopedArtifacts(store, `private-fqn/${id}`)
    const lines = []
    await assert.rejects(runStagingEffect(Effect.gen(function* () {
      return yield* storedBundle(store, `private-fqn/${id}`, id)
    })), error => {
      reportReleaseFailure(error, line => lines.push(line))
      assert.equal(error.code, code)
      return true
    })
    assert.deepEqual(lines, [`Staging release stopped: ${code}(${id})`])
  }
})

test('unreadable cached bytes refuse rather than substituting a fresh bundle', async () => {
  const store = createArtifactStore()
  const api = node('Api', { main: 'must-not-rebuild.js' })
  makeScopedArtifacts(store, api.resource.FQN)
  store.get(api.resource.FQN).set('build', { files: [{ path: 'main.js' }] })
  await assert.rejects(prepare(store, api))
})

test('unreviewed source arms refuse even when a cached bundle exists', async () => {
  for (const props of [{ source: {} }, { script: 'inline' }, { bundle: false }, { main: 'worker.py' }]) {
    const store = createArtifactStore()
    const api = node('Api', { main: 'worker.js', ...props })
    makeScopedArtifacts(store, api.resource.FQN)
    store.get(api.resource.FQN).set('build', { files: [{ path: 'main.js', content: 'bytes' }] })
    await assert.rejects(prepare(store, api), error => error.code === 'guard-artifact-source-unsupported' && error.logicalId === 'Api')
  }
})

test('Explore Vite retains the reviewed build-input pin without inventing a build cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hireling-vite-artifacts-'))
  try {
    const env = { NODE_ENV: 'production', VITE_EXAMPLE: 'fixture' }
    writeFileSync(join(dir, '.env.production'), 'VITE_EXAMPLE=from-file\n')
    const store = createArtifactStore()
    const artifacts = await prepare(store, node('Api', {}, 'noop'), { exploreDir: dir, env }, undefined, node('Explore', { vite: {} }))
    assert.deepEqual(artifacts.Explore, viteArtifact(key, 'Explore', env, { '.env.production': 'VITE_EXAMPLE=from-file\n' }))
    assert.equal(store.has('nested/Explore'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
