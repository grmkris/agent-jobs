import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expected, validateStagingEvidence } from './evidence.mjs'
import { validatePlanChanges } from './approved-changes.mjs'
import { sourceHashes, validateMigrationFixtureManifest } from './migration-fixtures.mjs'

export const wrapperSchemaVersion = 1

const targetOrder = ['Api', 'Indexer', 'Explore']
const trackDir = dirname(fileURLToPath(import.meta.url))
export const fileByteLimit = 8_388_608
export const packetByteLimit = 33_554_432

function onlyFields(value, allowed, required = allowed) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key))
}

function validPacketShape(bundle) {
  const fields = ['wrapperSchemaVersion', 'schemaVersion', 'accountId', 'stage', 'network', 'release', 'state', 'live', 'plan', 'rollback', 'liveChecks', 'artifacts', 'migrationManifest', 'approvedChanges']
  if (!onlyFields(bundle, fields, fields.filter(field => field !== 'approvedChanges'))) return false
  if (bundle.approvedChanges !== undefined && !onlyFields(bundle.approvedChanges, ['path', 'sha256'])) return false
  if (!onlyFields(bundle.release, ['commit', 'tree', 'clean', 'reviewed', 'excludedE39Worktree', 'excludedE39Revision', 'artifactHashes']) || !onlyFields(bundle.release.artifactHashes, targetOrder)) return false
  if (!onlyFields(bundle.state, ['backend', 'root', 'profile', 'permission', 'accountId', 'stack', 'stage', 'readable', 'readStatus', 'readMethod', 'observedAt', 'bootstrapAttempted', 'resources'], ['backend', 'accountId', 'stack', 'stage', 'readable', 'readStatus', 'readMethod', 'observedAt', 'bootstrapAttempted', 'resources'])) return false
  if (bundle.state.permission !== undefined && !onlyFields(bundle.state.permission, ['allowed', 'name', 'accountId', 'source', 'tokenId', 'observedAt'])) return false
  if (!Array.isArray(bundle.state.resources) || !bundle.state.resources.every((resource) => onlyFields(resource, ['logicalId', 'resourceId', 'accountId', 'status', 'providerMode', 'sha256']))) return false
  if (!onlyFields(bundle.live, ['observedAt', 'workers', 'domains'])) return false
  const aliasShape = (alias) => onlyFields(alias, ['hostname', 'service'])
  const bindingKeys = { Api: ['Database', 'Manifests', 'Board', 'DirectoryObject', 'DIRECTORY_DATABASE'], Indexer: ['Database'], Explore: ['API'] }
  if (!Array.isArray(bundle.live.workers) || !bundle.live.workers.every((worker) => onlyFields(worker, ['logicalId', 'resourceId', 'accountId', 'activeVersion', 'trafficPercent', 'bindings', 'cron'], ['logicalId', 'resourceId', 'accountId', 'activeVersion', 'trafficPercent', 'bindings']) && onlyFields(worker.bindings, bindingKeys[worker.logicalId] ?? [], []))) return false
  if (!Array.isArray(bundle.live.domains) || !bundle.live.domains.every(aliasShape)) return false
  if (!onlyFields(bundle.plan, ['mode', 'observedAt', 'commit', 'tree', 'stateMigration', 'migrations', 'secretChanges', 'settingsChanges', 'resourceCreates', 'domainChanges', 'scheduleChanges', 'operations'])) return false
  for (const field of ['migrations', 'secretChanges', 'settingsChanges', 'resourceCreates', 'domainChanges', 'scheduleChanges']) if (!Array.isArray(bundle.plan[field])) return false
  if (!Array.isArray(bundle.plan.operations) || !bundle.plan.operations.every((operation) => {
    if (!onlyFields(operation, ['logicalId', 'resourceId', 'action', 'bindings', 'aliases'], ['logicalId', 'resourceId', 'action'])) return false
    if (targetOrder.includes(operation.logicalId)) return onlyFields(operation.bindings, bindingKeys[operation.logicalId], []) && Array.isArray(operation.aliases) && operation.aliases.every(aliasShape)
    return !Object.hasOwn(operation, 'bindings') && !Object.hasOwn(operation, 'aliases')
  })) return false
  if (!onlyFields(bundle.rollback, ['versions', 'reviewed', 'storageCompatible']) || !onlyFields(bundle.rollback.versions, targetOrder)) return false
  if (!onlyFields(bundle.liveChecks, ['health', 'protocolChainId', 'directory', 'domainOwner', 'indexerMaxAgeSeconds', 'requireCheckpointProgress'])) return false
  if (!Array.isArray(bundle.artifacts) || !bundle.artifacts.every((artifact) => onlyFields(artifact, ['logicalId', 'resourceId', 'commit', 'tree', 'path', 'sha256']))) return false
  return validateMigrationFixtureManifest(bundle.migrationManifest).ok
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function readBoundedFile(name) {
  if (typeof name !== 'string' || !name) throw new Error('file')
  const path = resolve(trackDir, name)
  const lexical = relative(trackDir, path)
  if (!lexical || lexical.startsWith('..') || lexical.startsWith('/')) throw new Error('file')
  let parent = trackDir
  for (const segment of lexical.split('/')) {
    if (segment.startsWith('.') || /(?:^|[._-])(?:env|secrets?|credentials?)(?:[._-]|$)/i.test(segment)) throw new Error('file')
    parent = resolve(parent, segment)
    if (lstatSync(parent).isSymbolicLink()) throw new Error('file')
  }
  const real = realpathSync(path)
  const inside = relative(trackDir, real)
  const stat = lstatSync(path)
  if (!inside || inside.startsWith('..') || inside.startsWith('/') || !stat.isFile() || stat.size > fileByteLimit) throw new Error('file')
  const descriptor = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.size > fileByteLimit || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('file')
    const bytes = readFileSync(descriptor)
    if (bytes.length > fileByteLimit) throw new Error('file')
    return bytes
  } finally {
    closeSync(descriptor)
  }
}

function verifyArtifacts(bundle, blockers) {
  const artifacts = Array.isArray(bundle?.artifacts) ? bundle.artifacts : []
  let totalBytes = Buffer.byteLength(JSON.stringify(bundle), 'utf8')
  if (artifacts.length !== 3) blockers.add('artifact-census')
  for (const logicalId of targetOrder) {
    const matching = artifacts.filter((artifact) => artifact?.logicalId === logicalId)
    const artifact = matching[0]
    if (matching.length !== 1 || artifact?.resourceId !== expected.resources[logicalId] || artifact?.commit !== expected.commit || artifact?.tree !== expected.tree || artifact?.sha256 !== bundle?.release?.artifactHashes?.[logicalId]) blockers.add('artifact-provenance-mismatch')
    if (!/^[a-f0-9]{64}$/.test(artifact?.sha256 ?? '')) {
      blockers.add('artifact-digest-missing')
      continue
    }
    try {
      const bytes = readBoundedFile(artifact?.path)
      totalBytes += bytes.length
      if (totalBytes > packetByteLimit) throw new Error('size')
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== artifact.sha256) throw new Error('digest')
    } catch {
      blockers.add('artifact-path-or-digest-mismatch')
    }
  }
}

function reviewOnlyPlan(bundle, now) {
  const validation = validateStagingEvidence(bundle, now)
  const blockers = new Set(validation.blockers)
  verifyArtifacts(bundle, blockers)
  const migration = validateMigrationFixtureManifest(bundle?.migrationManifest ?? null)
  for (const blocker of migration.blockers) blockers.add(blocker)
  const approved = validatePlanChanges(bundle?.plan, bundle?.approvedChanges)
  for (const blocker of approved.blockers) blockers.add(blocker)
  const operations = Array.isArray(bundle?.plan?.operations) ? bundle.plan.operations : []
  const allowedBundleFields = ['wrapperSchemaVersion', 'schemaVersion', 'accountId', 'stage', 'network', 'release', 'state', 'live', 'plan', 'rollback', 'liveChecks', 'artifacts', 'migrationManifest', 'approvedChanges']
  const allowedPlanFields = ['mode', 'observedAt', 'commit', 'tree', 'stateMigration', 'migrations', 'secretChanges', 'settingsChanges', 'resourceCreates', 'domainChanges', 'scheduleChanges', 'operations']
  if (Object.keys(bundle).some((key) => !allowedBundleFields.includes(key)) || Object.keys(bundle?.plan ?? {}).some((key) => !allowedPlanFields.includes(key))) blockers.add('undeclared-wrapper-field')
  const forbiddenExecutionFields = ['execute', 'apply', 'upload', 'providerCommand', 'alchemyCommand', 'cloudflareCommand']
  for (const field of forbiddenExecutionFields) {
    if (Object.hasOwn(bundle ?? {}, field) || Object.hasOwn(bundle?.plan ?? {}, field)) blockers.add('execution-field-present')
  }
  if (Object.hasOwn(bundle ?? {}, 'applyRequested') || Object.hasOwn(bundle?.plan ?? {}, 'applyRequested') || Object.hasOwn(bundle ?? {}, 'applyAuthorized')) blockers.add('apply-requested')
  if (bundle?.plan?.mode !== 'review-only') blockers.add('review-only-mode-required')
  if (operations.some((operation) => operation?.action === 'create' || operation?.action === 'replace' || operation?.action === 'delete')) blockers.add('new-replaced-deleted-or-data-resource-write')

  const targets = targetOrder.map((logicalId) => ({
    logicalId,
    resourceId: expected.resources[logicalId],
    activeVersion: expected.versions[logicalId],
    action: ['update', 'noop'].includes(operations.find((operation) => operation?.logicalId === logicalId)?.action) ? operations.find((operation) => operation?.logicalId === logicalId).action : null,
  }))

  const modules = Object.fromEntries(['guard.mjs', 'evidence.mjs', 'migration-fixtures.mjs', 'approved-changes.mjs', 'approved-changes.json', 'entrypoint.mjs', 'digests.mjs'].map((name) => [name, createHash('sha256').update(readBoundedFile(name)).digest('hex')]))
  const reviewDigest = createHash('sha256').update(canonicalJson({ bundle, modules, sourceHashes, wrapperSchemaVersion, nodeVersion: process.version, sqliteVersion: process.versions.sqlite })).digest('hex')
  return {
    schemaVersion: wrapperSchemaVersion,
    ok: blockers.size === 0,
    applyAuthorized: false,
    mode: 'review-only',
    blockers: [...blockers],
    release: {
      commit: expected.commit,
      tree: expected.tree,
      stage: 'staging',
      network: 'monad-testnet',
    },
    targets,
    rollbackVersions: { ...expected.versions },
    deployCommand: null,
    mutation: 'forbidden',
    reviewDigest,
    releaseReady: false,
    evidenceTier: 'offline-saved-evidence-only',
    liveEvidence: false,
    unresolvedPrerequisites: ['live-directory-namespace-and-binding', 'approved-migration-tag-transition', 'compiled-class-and-provider-artifact-proof', 'workerd-and-provider-rollback-compatibility', 'approved-direct-worker-executor-unavailable'],
  }
}

export function evaluateExistingStackRelease(bundle, now = Date.now()) {
  if (bundle?.wrapperSchemaVersion !== wrapperSchemaVersion) {
    return {
      schemaVersion: wrapperSchemaVersion,
      ok: false,
      applyAuthorized: false,
      mode: 'review-only',
      blockers: ['wrapper-schema-version'],
      deployCommand: null,
      mutation: 'forbidden',
    }
  }
  try {
    if (!Number.isFinite(now) || Buffer.byteLength(JSON.stringify(bundle), 'utf8') > fileByteLimit) throw new Error('packet')
    const result = reviewOnlyPlan(bundle, now)
    if (!validPacketShape(bundle)) {
      result.ok = false
      result.blockers = [...new Set([...result.blockers, 'undeclared-or-malformed-wrapper-field'])]
    }
    return result
  } catch {
    return { schemaVersion: wrapperSchemaVersion, ok: false, applyAuthorized: false, mode: 'review-only', blockers: ['invalid-wrapper-input'], deployCommand: null, mutation: 'forbidden', releaseReady: false }
  }
}

export function runReviewCommand(args, now = Date.now()) {
  if (!Array.isArray(args) || args.length === 0) return { schemaVersion: wrapperSchemaVersion, ok: false, applyAuthorized: false, mode: 'review-only', blockers: ['review-input-required'], deployCommand: null, mutation: 'forbidden' }
  if (args.length !== 1 || typeof args[0] !== 'string' || args[0].startsWith('-')) return { schemaVersion: wrapperSchemaVersion, ok: false, applyAuthorized: false, mode: 'review-only', blockers: ['invalid-review-arguments'], deployCommand: null, mutation: 'forbidden' }
  try {
    const bundle = JSON.parse(readBoundedFile(resolve(process.cwd(), args[0])).toString('utf8'))
    return evaluateExistingStackRelease(bundle, now)
  } catch {
    return { schemaVersion: wrapperSchemaVersion, ok: false, applyAuthorized: false, mode: 'review-only', blockers: ['invalid-or-unreadable-input'], deployCommand: null, mutation: 'forbidden' }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runReviewCommand(process.argv.slice(2))
  console.log(JSON.stringify(result))
  process.exitCode = result.ok ? 0 : 1
}
