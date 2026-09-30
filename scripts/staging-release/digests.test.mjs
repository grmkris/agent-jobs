import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { createDigestManifest } from './digests.mjs'
import { expected } from './evidence.mjs'
import { fileByteLimit } from './guard.mjs'

const artifactBase = join(process.cwd(), 'scripts/staging-release/review-artifacts')
const source = { commit: expected.commit, tree: expected.tree }

function makeFixture() {
  const roots = {}
  for (const logicalId of ['Api', 'Indexer', 'Explore']) {
    mkdirSync(join(artifactBase, logicalId), { recursive: true })
    roots[logicalId] = mkdtempSync(join(artifactBase, logicalId, 'digest-fixture-'))
    writeFileSync(join(roots[logicalId], 'worker.mjs'), 'throw new Error("must-not-execute"); export default {}')
  }
  writeFileSync(join(roots.Explore, 'index.html'), '<!doctype html>')
  const targets = ['Api', 'Indexer', 'Explore'].map((logicalId) => ({
    logicalId,
    resourceId: expected.resources[logicalId],
    mainModule: `${logicalId}/${basename(roots[logicalId])}/worker.mjs`,
    modules: [{ path: `${logicalId}/${basename(roots[logicalId])}/worker.mjs` }],
    assets: logicalId === 'Explore' ? [{ path: `${logicalId}/${basename(roots[logicalId])}/index.html` }] : [],
  }))
  return { roots, input: { schemaVersion: 1, source, evidenceTier: 'offline-synthetic', targets } }
}

test('digest manifest hashes actual module and asset bytes but remains explicitly unavailable for release', () => {
  const fixture = makeFixture()
  try {
    const result = createDigestManifest(fixture.input)
    assert.equal(result.ok, true)
    assert.equal(result.artifactVerification, 'local-bytes-only')
    assert.equal(result.liveEvidence, false)
    assert.equal(result.releaseReady, false)
    assert.equal(result.applyAuthorized, false)
    assert.ok(result.blockers.includes('compiled-worker-provenance-unverified'))
    assert.equal(result.build.targets.length, 3)
    assert.match(result.build.targets[0].modules[0].sha256, /^[a-f0-9]{64}$/)
    assert.equal(result.build.targets[0].modules[0].sha256, createHash('sha256').update('throw new Error("must-not-execute"); export default {}').digest('hex'))
    assert.deepEqual(Object.keys(result).sort(), ['applyAuthorized', 'artifactVerification', 'blockers', 'build', 'deployCommand', 'evidenceTier', 'liveEvidence', 'manifestSha256', 'mutation', 'ok', 'releaseReady', 'schemaVersion'].sort())
    assert.equal(result.evidenceTier, 'offline-synthetic')
    assert.equal(result.build.compiledExports.verified, false)
    assert.equal(result.build.source.verifiedCompiledProvenance, false)
    const changedOrder = structuredClone(fixture.input)
    changedOrder.targets.reverse()
    changedOrder.source = { tree: expected.tree, commit: expected.commit }
    assert.equal(createDigestManifest(changedOrder).manifestSha256, result.manifestSha256)
    writeFileSync(join(fixture.roots.Api, 'worker.mjs'), 'export default {changed:true}')
    assert.notEqual(createDigestManifest(fixture.input).manifestSha256, result.manifestSha256)
  } finally {
    for (const root of Object.values(fixture.roots)) rmSync(root, { recursive: true, force: true })
  }
})

test('digest input rejects wrong source, unknown files, traversal, duplicates and symlinks', () => {
  const fixture = makeFixture()
  try {
    for (const mutate of [
      (input) => { input.source.commit = 'wrong' },
      (input) => { input.targets[0].modules.push({ path: 'Api/unknown.mjs' }) },
      (input) => { input.targets[0].modules[0].path = '../secret.mjs' },
      (input) => { input.targets[0].modules.push({ path: 'Api/worker.mjs' }) },
      (input) => { input.targets[0].resourceId = 'duplicate-worker' },
      (input) => { input.targets.pop() },
      (input) => { input.targets[1] = structuredClone(input.targets[0]) },
      (input) => { input.targets[0].providerCommand = 'untrusted-marker' },
      (input) => { input.targets[0].modules[0].sha256 = '0'.repeat(64) },
      (input) => { input.targets[0].mainModule = 'wrong.mjs' },
      (input) => { input.targets[2].assets = [] },
      (input) => { input.evidenceTier = 'live' },
      (input) => { input.buildCommand = 'untrusted-marker' },
    ]) {
      const input = structuredClone(fixture.input)
      mutate(input)
      assert.equal(createDigestManifest(input).ok, false)
      assert.ok(!JSON.stringify(createDigestManifest(input)).includes('untrusted-marker'))
    }
    symlinkSync(join(fixture.roots.Api, 'worker.mjs'), join(fixture.roots.Api, 'linked.mjs'))
    const linked = structuredClone(fixture.input)
    linked.targets[0].modules[0].path = `Api/${basename(fixture.roots.Api)}/linked.mjs`
    assert.equal(createDigestManifest(linked).ok, false)
  } finally {
    for (const root of Object.values(fixture.roots)) rmSync(root, { recursive: true, force: true })
  }
})

test('digest direct input rejects inherited fields', () => {
  const fixture = makeFixture()
  try {
    for (const mutate of [
      (input) => Object.assign(Object.create({ hidden: 'untrusted-marker' }), input),
      (input) => { input.source = Object.assign(Object.create({ hidden: 'untrusted-marker' }), input.source); return input },
      (input) => { input.targets[0] = Object.assign(Object.create({ hidden: 'untrusted-marker' }), input.targets[0]); return input },
      (input) => { input.targets[0].modules[0] = Object.assign(Object.create({ hidden: 'untrusted-marker' }), input.targets[0].modules[0]); return input },
      (input) => { input.targets[2].assets[0] = Object.assign(Object.create({ hidden: 'untrusted-marker' }), input.targets[2].assets[0]); return input },
    ]) {
      const result = createDigestManifest(mutate(structuredClone(fixture.input)))
      assert.equal(result.ok, false)
      assert.equal(result.applyAuthorized, false)
      assert.ok(!JSON.stringify(result).includes('untrusted-marker'))
    }
    const input = Object.assign(Object.create(null), fixture.input)
    assert.equal(createDigestManifest(input).ok, true)
  } finally {
    for (const root of Object.values(fixture.roots)) rmSync(root, { recursive: true, force: true })
  }
})

test('secret-like, special, oversize and unknown artifact names are rejected before they can count as modules', () => {
  const fixture = makeFixture()
  try {
    const prefix = `Api/${basename(fixture.roots.Api)}`
    writeFileSync(join(fixture.roots.Api, 'secrets.mjs'), 'untrusted-marker')
    writeFileSync(join(fixture.roots.Api, 'oversize.mjs'), '')
    truncateSync(join(fixture.roots.Api, 'oversize.mjs'), fileByteLimit + 1)
    for (const filename of [`${prefix}/secrets.mjs`, `${prefix}/oversize.mjs`, prefix, `${prefix}/worker.exe`, `${prefix}/../../outside.mjs`]) {
      const input = structuredClone(fixture.input)
      input.targets[0].mainModule = filename
      input.targets[0].modules = [{ path: filename }]
      const output = createDigestManifest(input)
      assert.equal(output.ok, false)
      assert.ok(!JSON.stringify(output).includes('untrusted-marker'))
    }
  } finally {
    for (const root of Object.values(fixture.roots)) rmSync(root, { recursive: true, force: true })
  }
})

test('aggregate artifact size rejects before an oversized packet can be emitted', () => {
  const fixture = makeFixture()
  try {
    const input = structuredClone(fixture.input)
    for (let index = 0; index < 5; index += 1) {
      const name = `large-${index}.mjs`
      writeFileSync(join(fixture.roots.Api, name), '')
      truncateSync(join(fixture.roots.Api, name), fileByteLimit)
      input.targets[0].modules.push({ path: `Api/${basename(fixture.roots.Api)}/${name}` })
    }
    assert.equal(createDigestManifest(input).ok, false)
  } finally {
    for (const root of Object.values(fixture.roots)) rmSync(root, { recursive: true, force: true })
  }
})

test('digest CLI succeeds only as a local-byte manifest and refuses flags and malformed inputs', () => {
  const fixture = makeFixture()
  const inputDir = mkdtempSync(join(process.cwd(), 'scripts/staging-release/digest-fixture-'))
  try {
    const inputFile = join(inputDir, 'synthetic.json')
    const malformed = join(inputDir, 'malformed.json')
    writeFileSync(inputFile, JSON.stringify(fixture.input))
    writeFileSync(malformed, '{untrusted-marker')
    const good = spawnSync(process.execPath, ['scripts/staging-release/digests.mjs', inputFile], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(good.status, 0)
    assert.equal(JSON.parse(good.stdout).releaseReady, false)
    for (const args of [[], ['--apply'], [inputFile, '--apply'], [malformed], ['/etc/hosts']]) {
      const child = spawnSync(process.execPath, ['scripts/staging-release/digests.mjs', ...args], { encoding: 'utf8', timeout: 10_000 })
      assert.equal(child.status, 1)
      const output = JSON.parse(child.stdout)
      assert.equal(output.ok, false)
      assert.equal(output.applyAuthorized, false)
      assert.equal(output.deployCommand, null)
      assert.ok(!child.stdout.includes('untrusted-marker'))
    }
    assert.equal(JSON.parse(readFileSync(inputFile, 'utf8')).evidenceTier, 'offline-synthetic')
  } finally {
    for (const root of Object.values(fixture.roots)) rmSync(root, { recursive: true, force: true })
    rmSync(inputDir, { recursive: true, force: true })
  }
})

test('digest CLI has no provider/build fallback and rejects unavailable synthetic input', () => {
  const result = spawnSync(process.execPath, ['scripts/staging-release/digests.mjs', 'scripts/staging-release/fixtures/unavailable-build.json'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  const output = JSON.parse(result.stdout)
  assert.equal(output.ok, false)
  assert.equal(output.applyAuthorized, false)
  assert.equal(output.deployCommand, null)
  assert.ok(!result.stdout.includes('alchemy'))
})
