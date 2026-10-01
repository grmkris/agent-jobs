import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { expected } from './evidence.mjs'
import { evaluateExistingStackRelease, fileByteLimit, wrapperSchemaVersion } from './guard.mjs'
import { migrationManifest } from './migration-fixtures.mjs'

const now = Date.parse('2026-09-30T20:40:00Z')
const stamp = new Date(now).toISOString()
const artifactHash = createHash('sha256').update(readFileSync(new URL('./evidence.mjs', import.meta.url))).digest('hex')
const track = dirname(fileURLToPath(import.meta.url))

function fixture() {
  const operations = Object.entries(expected.resources).map(([logicalId, resourceId]) => ({
    logicalId,
    resourceId,
    action: ['Api', 'Indexer', 'Explore'].includes(logicalId) ? 'update' : 'noop',
  }))
  const workers = [
    { logicalId: 'Api', resourceId: expected.resources.Api, accountId: expected.accountId, activeVersion: expected.versions.Api, trafficPercent: 100, bindings: { Database: expected.resources.Database, Manifests: expected.resources.Manifests, Board: expected.boardNamespace, DirectoryObject: '1'.repeat(32), DIRECTORY_DATABASE: expected.resources.Database } },
    { logicalId: 'Indexer', resourceId: expected.resources.Indexer, accountId: expected.accountId, activeVersion: expected.versions.Indexer, trafficPercent: 100, bindings: { Database: expected.resources.Database }, cron: '* * * * *' },
    { logicalId: 'Explore', resourceId: expected.resources.Explore, accountId: expected.accountId, activeVersion: expected.versions.Explore, trafficPercent: 100, bindings: { API: expected.resources.Api } },
  ]
  for (const operation of operations) {
    const worker = workers.find((entry) => entry.logicalId === operation.logicalId)
    if (worker) {
      operation.bindings = { ...worker.bindings }
      operation.aliases = operation.logicalId === 'Explore' ? expected.domains.map((hostname) => ({ hostname, service: expected.resources.Explore })) : []
    }
  }
  return {
    wrapperSchemaVersion,
    schemaVersion: 1,
    migrationManifest,
    accountId: expected.accountId,
    stage: 'staging',
    network: 'monad-testnet',
    release: { commit: expected.commit, tree: expected.tree, clean: true, reviewed: true, excludedE39Worktree: true, excludedE39Revision: '5c3cf6fcf67260261b1bf8ff12aa2c185d28083d', artifactHashes: { Api: artifactHash, Indexer: artifactHash, Explore: artifactHash } },
    artifacts: ['Api', 'Indexer', 'Explore'].map((logicalId) => ({ logicalId, resourceId: expected.resources[logicalId], commit: expected.commit, tree: expected.tree, path: 'evidence.mjs', sha256: artifactHash })),
    state: { backend: 'local', root: expected.localStateRoot, accountId: expected.accountId, stack: 'AgentJobs', stage: 'staging', readable: true, readStatus: 200, readMethod: 'filesystem-read', observedAt: stamp, bootstrapAttempted: false, resources: Object.entries(expected.resources).map(([logicalId, resourceId]) => ({ logicalId, resourceId, accountId: expected.accountId, status: 'updated', providerMode: 'live', sha256: '4'.repeat(64) })) },
    live: { observedAt: stamp, workers, domains: expected.domains.map((hostname) => ({ hostname, service: expected.resources.Explore })) },
    plan: { mode: 'review-only', observedAt: stamp, commit: expected.commit, tree: expected.tree, stateMigration: false, migrations: [], secretChanges: [], resourceCreates: [], domainChanges: [], scheduleChanges: [], operations },
    rollback: { versions: { ...expected.versions }, reviewed: true, storageCompatible: true },
    liveChecks: { health: true, protocolChainId: 10143, directory: true, domainOwner: true, indexerMaxAgeSeconds: 180, requireCheckpointProgress: true },
  }
}

test('synthetic evidence validates only an offline packet and produces no deploy command', () => {
  const result = evaluateExistingStackRelease(fixture(), now)
  assert.equal(result.ok, true)
  assert.equal(result.applyAuthorized, false)
  assert.equal(result.deployCommand, null)
  assert.equal(result.mutation, 'forbidden')
  assert.equal(result.releaseReady, false)
  assert.equal(result.liveEvidence, false)
  assert.equal(result.evidenceTier, 'offline-saved-evidence-only')
  assert.deepEqual(result.targets.map((target) => target.resourceId), [expected.resources.Api, expected.resources.Indexer, expected.resources.Explore])
})

for (const [name, mutate, blocker] of [
  ['wrong wrapper schema', (bundle) => { bundle.wrapperSchemaVersion = 2 }, 'wrapper-schema-version'],
  ['apply request', (bundle) => { bundle.applyRequested = true }, 'apply-requested'],
  ['provider command', (bundle) => { bundle.providerCommand = 'alchemy deploy' }, 'execution-field-present'],
  ['missing artifact', (bundle) => { bundle.artifacts.pop() }, 'artifact-census'],
  ['artifact escape', (bundle) => { bundle.artifacts[0].path = '/etc/hosts' }, 'artifact-path-or-digest-mismatch'],
  ['artifact drift', (bundle) => { bundle.artifacts[0].sha256 = '0'.repeat(64) }, 'artifact-path-or-digest-mismatch'],
  ['wrong artifact target', (bundle) => { bundle.artifacts[0].resourceId = 'duplicate-worker' }, 'artifact-provenance-mismatch'],
  ['non-review mode', (bundle) => { bundle.plan.mode = 'apply' }, 'review-only-mode-required'],
  ['resource creation', (bundle) => { bundle.plan.operations[0].action = 'create' }, 'new-replaced-deleted-or-data-resource-write'],
]) {
  test(`fails closed for ${name}`, () => {
    const bundle = fixture()
    mutate(bundle)
    const result = evaluateExistingStackRelease(bundle, now)
    assert.equal(result.ok, false)
    assert.equal(result.applyAuthorized, false)
    assert.equal(result.deployCommand, null)
    assert.ok(result.blockers.includes(blocker))
  })
}

const reorder = (value) => Array.isArray(value) ? value.map(reorder) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).toReversed().map(([key, child]) => [key, reorder(child)])) : value

test('canonical review digest ignores object key order but binds reviewed inputs', () => {
  const bundle = fixture()
  const original = evaluateExistingStackRelease(bundle, now)
  assert.equal(original.reviewDigest, evaluateExistingStackRelease(reorder(bundle), now).reviewDigest)
  bundle.liveChecks.health = false
  assert.notEqual(original.reviewDigest, evaluateExistingStackRelease(bundle, now).reviewDigest)
})

test('unknown nested fields and execution attempts are rejected at each packet boundary', () => {
  for (const mutate of [
    (bundle) => { bundle.release.execute = true },
    (bundle) => { bundle.release.artifactHashes.Secret = 'untrusted-marker' },
    (bundle) => { bundle.state.execute = true },
    (bundle) => { bundle.state.resources[0].execute = true },
    (bundle) => { bundle.live.execute = true },
    (bundle) => { bundle.live.workers[0].execute = true },
    (bundle) => { bundle.live.workers[0].bindings.Secret = 'untrusted-marker' },
    (bundle) => { bundle.live.domains[0].execute = true },
    (bundle) => { bundle.plan.operations[0].execute = true },
    (bundle) => { bundle.plan.operations[2].aliases[0].execute = true },
    (bundle) => { bundle.rollback.execute = true },
    (bundle) => { bundle.rollback.versions.Secret = 'untrusted-marker' },
    (bundle) => { bundle.liveChecks.execute = true },
    (bundle) => { bundle.artifacts[0].execute = true },
    (bundle) => { bundle.migrationManifest = { ...migrationManifest, execute: true } },
  ]) {
    const bundle = fixture()
    mutate(bundle)
    const result = evaluateExistingStackRelease(bundle, now)
    assert.equal(result.ok, false)
    assert.equal(result.applyAuthorized, false)
    assert.ok(result.blockers.includes('undeclared-or-malformed-wrapper-field'))
    assert.ok(!JSON.stringify(result).includes('untrusted-marker'))
  }
})

test('malformed exported evaluator inputs return sanitized refusal rather than throwing', () => {
  for (const bundle of [null, [], {}, { wrapperSchemaVersion }, { wrapperSchemaVersion, plan: { operations: [null] } }]) {
    const result = evaluateExistingStackRelease(bundle, now)
    assert.equal(result.ok, false)
    assert.equal(result.applyAuthorized, false)
    assert.equal(result.deployCommand, null)
  }
  const circular = fixture()
  circular.loop = circular
  assert.equal(evaluateExistingStackRelease(circular, now).ok, false)
})

test('observed saved evidence stays rejected without timestamp or binding fabrication', () => {
  const observed = JSON.parse(readFileSync(join(track, 'fixtures/observed-evidence.json'), 'utf8'))
  const result = evaluateExistingStackRelease(observed, now)
  assert.equal(result.ok, false)
  assert.deepEqual(result.blockers, ['wrapper-schema-version'])
  assert.equal(result.applyAuthorized, false)
  assert.equal(result.deployCommand, null)
})

test('stale and future synthetic timestamps cannot pass wrapper validation', () => {
  for (const clock of [now - 1, now + 300_001]) assert.equal(evaluateExistingStackRelease(fixture(), clock).ok, false)
})

test('track-local file boundaries reject secret paths, symlinks, missing, special and oversized artifacts', () => {
  const root = mkdtempSync(join(track, 'offline-wrapper-fixture-'))
  try {
    writeFileSync(join(root, 'artifact.js'), 'synthetic')
    mkdirSync(join(root, 'secret'))
    writeFileSync(join(root, 'secret', 'artifact.js'), 'synthetic')
    symlinkSync(join(root, 'artifact.js'), join(root, 'linked.js'))
    symlinkSync(root, join(root, 'linked-dir'))
    closeSync(openSync(join(root, 'oversized.js'), 'w'))
    truncateSync(join(root, 'oversized.js'), fileByteLimit + 1)
    const digest = createHash('sha256').update('synthetic').digest('hex')
    for (const path of [join(root, 'secret', 'artifact.js'), join(root, 'linked.js'), join(root, 'linked-dir', 'artifact.js'), join(root, 'missing.js'), root, join(root, 'oversized.js')]) {
      const bundle = fixture()
      bundle.artifacts[0].path = path
      bundle.artifacts[0].sha256 = digest
      bundle.release.artifactHashes.Api = digest
      const result = evaluateExistingStackRelease(bundle, now)
      assert.ok(result.blockers.includes('artifact-path-or-digest-mismatch'))
      assert.equal(result.ok, false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('mandatory offline CLI grammar succeeds only for valid synthetic input and sanitizes refusals', () => {
  const root = mkdtempSync(join(track, 'offline-wrapper-cli-'))
  const wrapper = join(track, 'guard.mjs')
  const run = (args) => {
    const child = spawnSync(process.execPath, [wrapper, ...args], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(child.error, undefined)
    return { child, output: JSON.parse(child.stdout) }
  }
  try {
    const bundle = fixture()
    const current = new Date().toISOString()
    bundle.state.observedAt = current
    bundle.live.observedAt = current
    bundle.plan.observedAt = current
    writeFileSync(join(root, 'synthetic.json'), JSON.stringify(bundle))
    writeFileSync(join(root, 'invalid.json'), '{untrusted-marker')
    writeFileSync(join(root, 'secrets.env'), 'untrusted-marker')
    symlinkSync(join(root, 'synthetic.json'), join(root, 'linked.json'))
    const success = run([join(root, 'synthetic.json')])
    assert.equal(success.child.status, 0)
    assert.equal(success.output.ok, true)
    assert.equal(success.output.releaseReady, false)
    assert.equal(success.output.liveEvidence, false)
    for (const args of [[], ['--apply'], [join(root, 'synthetic.json'), '--apply'], [join(root, 'invalid.json')], [join(root, 'secrets.env')], [join(root, 'linked.json')], ['/etc/hosts'], [join(track, 'fixtures/observed-evidence.json')]]) {
      const { child, output } = run(args)
      assert.equal(child.status, 1)
      assert.equal(output.ok, false)
      assert.equal(output.applyAuthorized, false)
      assert.equal(output.deployCommand, null)
      assert.ok(!child.stdout.includes('untrusted-marker'))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
