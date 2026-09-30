import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { expected, validateStagingEvidence } from './evidence.mjs'

const now = Date.parse('2026-09-30T20:40:00Z')
const stamp = new Date(now).toISOString()
function fixture() {
  const bundle = {
    schemaVersion: 1, accountId: expected.accountId, stage: 'staging', network: 'monad-testnet',
    release: { commit: expected.commit, tree: expected.tree, clean: true, reviewed: true, excludedE39Worktree: true, excludedE39Revision: '5c3cf6fcf67260261b1bf8ff12aa2c185d28083d', artifactHashes: { Api: '1'.repeat(64), Indexer: '2'.repeat(64), Explore: '3'.repeat(64) } },
    state: { backend: 'remote', profile: 'default', accountId: expected.accountId, stack: 'AgentJobs', stage: 'staging', readable: true, readStatus: 200, readMethod: 'GET', observedAt: stamp, bootstrapAttempted: false,
      permission: { name: 'Secrets Store Edit', accountId: expected.accountId, allowed: true, source: 'token-policy-get', tokenId: 'synthetic-token-id', observedAt: stamp },
      resources: Object.entries(expected.resources).map(([logicalId, resourceId]) => ({ logicalId, resourceId, accountId: expected.accountId, status: 'updated', providerMode: 'live' })) },
    live: { observedAt: stamp, workers: [
      { logicalId: 'Api', resourceId: expected.resources.Api, accountId: expected.accountId, activeVersion: expected.versions.Api, trafficPercent: 100, bindings: { Database: expected.resources.Database, Manifests: expected.resources.Manifests, Board: expected.boardNamespace, DirectoryObject: '1'.repeat(32), DIRECTORY_DATABASE: expected.resources.Database } },
      { logicalId: 'Indexer', resourceId: expected.resources.Indexer, accountId: expected.accountId, activeVersion: expected.versions.Indexer, trafficPercent: 100, bindings: { Database: expected.resources.Database }, cron: '* * * * *' },
      { logicalId: 'Explore', resourceId: expected.resources.Explore, accountId: expected.accountId, activeVersion: expected.versions.Explore, trafficPercent: 100, bindings: { API: expected.resources.Api } },
    ], domains: expected.domains.map((hostname) => ({ hostname, service: expected.resources.Explore })) },
    plan: { observedAt: stamp, commit: expected.commit, tree: expected.tree, stateMigration: false, migrations: [], secretChanges: [], resourceCreates: [], domainChanges: [], scheduleChanges: [],
      operations: Object.entries(expected.resources).map(([logicalId, resourceId]) => ({ logicalId, resourceId, action: ['Api', 'Indexer', 'Explore'].includes(logicalId) ? 'update' : 'noop' })) },
    rollback: { versions: { ...expected.versions }, reviewed: true, storageCompatible: true },
    liveChecks: { health: true, protocolChainId: 10143, directory: true, domainOwner: true, indexerMaxAgeSeconds: 180, requireCheckpointProgress: true },
  }
  for (const operation of bundle.plan.operations) {
    const worker = bundle.live.workers.find((entry) => entry.logicalId === operation.logicalId)
    if (worker) {
      operation.bindings = { ...worker.bindings }
      operation.aliases = operation.logicalId === 'Explore' ? bundle.live.domains.map((domain) => ({ ...domain })) : []
    }
  }
  return bundle
}

test('synthetic complete evidence passes validation but never authorizes application', () => {
  assert.deepEqual(validateStagingEvidence(fixture(), now), { ok: true, applyAuthorized: false, blockers: [] })
})

const failures = [
  ['missing state', 'state-unreadable', (bundle) => { delete bundle.state }],
  ['unproved local fallback', 'state-backend-identity-mismatch', (bundle) => { bundle.state.backend = 'local' }],
  ['remote 403', 'state-unreadable', (bundle) => { bundle.state.readStatus = 403 }],
  ['unknown backend', 'state-backend-unknown', (bundle) => { bundle.state.backend = 'other' }],
  ['local-provider staging record', 'state-provider-mode-mismatch', (bundle) => { bundle.state.resources[0].providerMode = 'local' }],
  ['missing permission', 'secrets-store-edit-unverified', (bundle) => { delete bundle.state.permission }],
  ['read permission', 'secrets-store-edit-unverified', (bundle) => { bundle.state.permission.name = 'Secrets Store Read' }],
  ['wrong permission account', 'secrets-store-edit-unverified', (bundle) => { bundle.state.permission.accountId = 'other' }],
  ['unverified permission source', 'permission-evidence-unverified', (bundle) => { bundle.state.permission.source = 'state-readable' }],
  ['missing state resource', 'state-resource-census', (bundle) => { bundle.state.resources.pop() }],
  ['duplicate state', 'state-resource-identity-mismatch', (bundle) => { bundle.state.resources[0].resourceId = 'duplicate-api' }],
  ['in-flight state', 'state-not-ready', (bundle) => { bundle.state.resources[0].status = 'creating' }],
  ['resource create', 'new-replaced-deleted-or-data-resource-write', (bundle) => { bundle.plan.operations[0].action = 'create' }],
  ['resource replace', 'new-replaced-deleted-or-data-resource-write', (bundle) => { bundle.plan.operations[0].action = 'replace' }],
  ['resource deletion', 'new-replaced-deleted-or-data-resource-write', (bundle) => { bundle.plan.operations[0].action = 'delete' }],
  ['wrong plan target', 'plan-resource-identity-mismatch', (bundle) => { bundle.plan.operations[0].resourceId = 'duplicate-api' }],
  ['alias conflict', 'domain-ownership-or-alias-conflict', (bundle) => { bundle.live.domains[0].service = 'duplicate-explore' }],
  ['new alias', 'unapproved-additive-or-config-change', (bundle) => { bundle.plan.domainChanges.push('new-alias') }],
  ['alias conflict hidden inside update', 'planned-alias-conflict', (bundle) => { bundle.plan.operations[2].aliases[0].service = 'duplicate-explore' }],
  ['planned binding swap', 'planned-binding-drift', (bundle) => { bundle.plan.operations[0].bindings.Database = 'duplicate-d1' }],
  ['undeclared update property', 'undeclared-plan-operation', (bundle) => { bundle.plan.operations[0].hiddenCreate = 'other-worker' }],
  ['unexpected new resource', 'unapproved-additive-or-config-change', (bundle) => { bundle.plan.resourceCreates.push('DirectoryObject') }],
  ['missing directory namespace', 'directory-namespace-missing-or-duplicate', (bundle) => { delete bundle.live.workers[0].bindings.DirectoryObject }],
  ['duplicate directory namespace', 'directory-namespace-missing-or-duplicate', (bundle) => { bundle.live.workers[0].bindings.DirectoryObject = expected.duplicateDirectoryNamespace }],
  ['wrong directory D1 alias', 'directory-d1-alias-missing-or-wrong', (bundle) => { bundle.live.workers[0].bindings.DIRECTORY_DATABASE = 'duplicate-d1' }],
  ['bootstrap requested', 'state-bootstrap-or-migration', (bundle) => { bundle.state.bootstrapAttempted = true }],
  ['state migration', 'state-bootstrap-or-migration', (bundle) => { bundle.plan.stateMigration = true }],
  ['stale evidence', 'stale-or-future-evidence', (bundle) => { bundle.state.observedAt = new Date(now - 301_000).toISOString() }],
  ['future evidence', 'stale-or-future-evidence', (bundle) => { bundle.state.observedAt = new Date(now + 1).toISOString() }],
  ['unreviewed revision', 'unreviewed-revision', (bundle) => { bundle.release.commit = '0'.repeat(40) }],
  ['dirty release', 'release-review-or-dirty-tree', (bundle) => { bundle.release.clean = false }],
  ['e39 scope mixed in', 'e39-revision-not-isolated', (bundle) => { bundle.release.excludedE39Worktree = false }],
  ['e39 follow-up revision mixed in', 'e39-revision-not-isolated', (bundle) => { bundle.release.excludedE39Revision = expected.commit }],
  ['unsafe rollback', 'rollback-compatibility-unverified', (bundle) => { bundle.rollback.storageCompatible = false }],
  ['wrong rollback version', 'rollback-version-mismatch', (bundle) => { bundle.rollback.versions.Api = 'other' }],
  ['missing live checks', 'live-check-contract-incomplete', (bundle) => { delete bundle.liveChecks }],
  ['stalled indexer allowed', 'indexer-check-contract-incomplete', (bundle) => { bundle.liveChecks.requireCheckpointProgress = false }],
]
for (const [name, blocker, mutate] of failures) {
  test(`refuses ${name}`, () => {
    const bundle = fixture()
    mutate(bundle)
    const result = validateStagingEvidence(bundle, now)
    assert.equal(result.ok, false)
    assert.ok(result.blockers.includes(blocker))
    assert.equal(result.applyAuthorized, false)
  })
}

test('the recorded real remote state fails existing-stack identity checks', () => {
  const remote = JSON.parse(readFileSync(new URL('./fixtures/remote-identities.json', import.meta.url), 'utf8'))
  const bundle = fixture()
  bundle.state.resources = remote.resources.map((resource) => ({
    logicalId: resource.logicalId,
    resourceId: resource.identity.workerName ?? resource.identity.databaseId ?? resource.identity.bucketName,
    accountId: resource.identity.accountId,
    status: resource.status,
    providerMode: resource.providerMode,
  }))
  const result = validateStagingEvidence(bundle, now)
  assert.equal(result.ok, false)
  assert.ok(result.blockers.includes('state-resource-identity-mismatch'))
  assert.ok(result.blockers.includes('state-not-ready'))
})

function localFixture() {
  const bundle = fixture()
  bundle.state.backend = 'local'
  bundle.state.root = expected.localStateRoot
  bundle.state.readMethod = 'filesystem-read'
  delete bundle.state.permission
  for (const resource of bundle.state.resources) resource.sha256 = '4'.repeat(64)
  return bundle
}

test('synthetic authoritative local staging state does not require remote Secrets Store permission', () => {
  assert.deepEqual(validateStagingEvidence(localFixture(), now), { ok: true, applyAuthorized: false, blockers: [] })
})

test('state-empty local worktree is not an automatic fallback', () => {
  const bundle = localFixture()
  bundle.state.root = '/home/kristjan/code/agent-jobs-e38/.alchemy/state/AgentJobs/staging'
  assert.ok(validateStagingEvidence(bundle, now).blockers.includes('state-backend-identity-mismatch'))
})

test('local staging requires sanitized state digests', () => {
  const bundle = localFixture()
  delete bundle.state.resources[0].sha256
  assert.ok(validateStagingEvidence(bundle, now).blockers.includes('local-state-digest-missing'))
})

test('real local identity snapshot maps existing resources but does not supply missing directory migration', () => {
  const inventory = JSON.parse(readFileSync(new URL('./fixtures/local-identities.json', import.meta.url), 'utf8'))
  const bundle = localFixture()
  bundle.state.resources = inventory.localState[0].resources.filter((resource) => resource.logicalId).map((resource) => ({
    logicalId: resource.logicalId,
    resourceId: resource.identity.workerName ?? resource.identity.databaseId ?? resource.identity.bucketName,
    accountId: resource.identity.accountId, status: resource.status, providerMode: resource.providerMode, sha256: resource.sha256,
  }))
  delete bundle.live.workers[0].bindings.DirectoryObject
  delete bundle.live.workers[0].bindings.DIRECTORY_DATABASE
  bundle.plan.operations[0].bindings = { ...bundle.live.workers[0].bindings }
  const result = validateStagingEvidence(bundle, now)
  assert.equal(result.ok, false)
  assert.equal(result.applyAuthorized, false)
  assert.ok(!result.blockers.includes('state-resource-identity-mismatch'))
  assert.ok(!result.blockers.includes('secrets-store-edit-unverified'))
  assert.ok(result.blockers.includes('directory-namespace-missing-or-duplicate'))
  assert.ok(result.blockers.includes('directory-d1-alias-missing-or-wrong'))
})

test('malformed evidence fails closed without returning input values', () => {
  for (const bundle of [null, undefined, {}, [], 'private-input-value']) {
    const result = validateStagingEvidence(bundle, now)
    assert.equal(result.ok, false)
    assert.ok(!JSON.stringify(result).includes('private-input-value'))
  }
})
