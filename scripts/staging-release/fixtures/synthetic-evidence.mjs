import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expected } from '../evidence.mjs'
import { migrationManifest } from '../migration-fixtures.mjs'
import { wrapperSchemaVersion } from '../guard.mjs'

const artifactHash = createHash('sha256').update(readFileSync(new URL('../evidence.mjs', import.meta.url))).digest('hex')

export function syntheticEvidence(clock = Date.now()) {
  const stamp = new Date(clock).toISOString()
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
