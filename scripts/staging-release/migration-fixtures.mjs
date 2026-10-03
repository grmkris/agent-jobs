import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const trackDir = dirname(fileURLToPath(import.meta.url))
export const pinnedSourceRoot = resolve(trackDir, '../..')

export const migrationManifest = Object.freeze({
  kind: 'additive-directory-v1',
  className: 'DirectoryObject',
  sourceExport: 'default',
  compiledExportRequired: 'DirectoryObject',
  namespaceId: null,
  priorMigrationTag: null,
  migrationTag: null,
  priorTagVerified: false,
  existingDatabaseId: '1b2ddfdd-650e-4846-8b55-fca07872efec',
  bindings: Object.freeze({ DIRECTORY_DATABASE: '1b2ddfdd-650e-4846-8b55-fca07872efec' }),
  d1Tables: Object.freeze(['directory_agents']),
  d1PrimaryKey: '(chain_id, registry, audience, agent_key)',
  durableObjectTables: Object.freeze(['directory_state', 'directory_projection']),
  destructiveOperations: Object.freeze([]),
})

export const sourceHashes = Object.freeze({
  'apps/api/src/directory-object.ts': '33908ef80092362753b6603d7d469426801fb9dd5797e16959133cc8fce63d7b',
  'apps/api/src/directory.ts': 'd58f1a143f56362f161fb1aaba37c3d6f4a20e8490151b7d3f5001eb8079c0d8',
  'apps/api/src/directory-projection.ts': '0f0fdea6424480291fd6f80cfa19a7d1e2591a0c5e15146c1175414b364de430',
  'packages/board/src/directory.ts': 'd1ddb3b19aa648565ddbc4cc007f0f60da9312ee8e5326bc5052ae71b1218802',
})

export function loadPinnedDirectorySchema(repoRoot = pinnedSourceRoot) {
  if (typeof repoRoot !== 'string') throw new Error('source-root-refused')
  const root = resolve(repoRoot)
  const ownedFixture = dirname(root) === trackDir && /^\.source-fixture-[a-zA-Z0-9]+$/.test(basename(root))
  if ((root !== pinnedSourceRoot && !ownedFixture) || lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw new Error('source-root-refused')
  const sources = {}
  for (const [name, expected] of Object.entries(sourceHashes)) {
    let path = root
    for (const segment of name.split('/')) {
      path = resolve(path, segment)
      if (lstatSync(path).isSymbolicLink()) throw new Error('source-path-refused')
    }
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 1_048_576 || relative(root, realpathSync(path)).startsWith('..')) throw new Error('source-path-refused')
    const bytes = readFileSync(path)
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('pinned-source-drift')
    sources[name] = bytes.toString('utf8')
  }
  if (!sources['apps/api/src/directory-object.ts'].includes('export default class DirectoryObject')) throw new Error('source-class-export-mismatch')
  const d1 = sources['apps/api/src/directory.ts'].match(/`(CREATE TABLE IF NOT EXISTS directory_agents \([\s\S]*?\))`/)?.[1]
  const state = sources['packages/board/src/directory.ts'].match(/'(CREATE TABLE IF NOT EXISTS directory_state \([^']*\))'/)?.[1]
  const journal = sources['apps/api/src/directory-projection.ts'].match(/'(CREATE TABLE IF NOT EXISTS directory_projection \([^']*\))'/)?.[1]
  if (!d1 || !state || !journal) throw new Error('pinned-schema-missing')
  return { d1, state, journal, applyAuthorized: false }
}

const isPlainRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))

export function validateMigrationFixtureManifest(manifest = migrationManifest) {
  const blockers = []
  if (!isPlainRecord(manifest)) return { ok: false, blockers: ['invalid-migration-manifest'], applyAuthorized: false }
  if (manifest.kind !== 'additive-directory-v1') blockers.push('migration-kind-mismatch')
  if (manifest.className !== 'DirectoryObject' || manifest.sourceExport !== 'default' || manifest.compiledExportRequired !== 'DirectoryObject') blockers.push('directory-class-export-mismatch')
  if (manifest.namespaceId !== null) blockers.push('namespace-preassigned')
  if (manifest.priorMigrationTag !== null || manifest.migrationTag !== null || manifest.priorTagVerified !== false) blockers.push('migration-tag-unreviewed')
  if (manifest.existingDatabaseId !== '1b2ddfdd-650e-4846-8b55-fca07872efec') blockers.push('existing-d1-mismatch')
  if (!isPlainRecord(manifest.bindings) || manifest.bindings.DIRECTORY_DATABASE !== manifest.existingDatabaseId || Object.keys(manifest.bindings).length !== 1) blockers.push('directory-d1-alias-mismatch')
  if (!Array.isArray(manifest.d1Tables) || manifest.d1Tables.join(',') !== 'directory_agents') blockers.push('directory-schema-mismatch')
  if (manifest.d1PrimaryKey !== '(chain_id, registry, audience, agent_key)') blockers.push('directory-primary-key-mismatch')
  if (!Array.isArray(manifest.durableObjectTables) || manifest.durableObjectTables.join(',') !== 'directory_state,directory_projection') blockers.push('directory-do-schema-mismatch')
  if (!Array.isArray(manifest.destructiveOperations) || manifest.destructiveOperations.length !== 0) blockers.push('destructive-migration')
  if (Object.keys(manifest).some((key) => !Object.hasOwn(migrationManifest, key))) blockers.push('undeclared-migration-operation')
  return { ok: blockers.length === 0, blockers, applyAuthorized: false }
}

export function applyAdditiveDirectoryFixture(databases, schema, manifest = migrationManifest) {
  if (!validateMigrationFixtureManifest(manifest).ok) throw new Error('migration-fixture-refused')
  const pinned = loadPinnedDirectorySchema()
  if (!schema || Object.keys(schema).toSorted().join(',') !== Object.keys(pinned).toSorted().join(',') || Object.keys(pinned).some((key) => schema[key] !== pinned[key])) throw new Error('pinned-schema-drift')
  databases.d1.exec(schema.d1)
  databases.directory.exec(schema.state)
  databases.directory.exec(schema.journal)
}

export function readOldCodeFixture(databases) {
  return {
    job61: databases.d1.prepare('SELECT id, state FROM jobs WHERE id = 61').get(),
    checkpoint: databases.d1.prepare('SELECT chain_id, next_block FROM checkpoint WHERE chain_id = 10143').get(),
    board: databases.board.prepare('SELECT id, json FROM board_state WHERE id = 1').get(),
  }
}

export function readNewCodeFixture(databases) {
  return {
    directory: databases.d1.prepare('SELECT * FROM directory_agents').get(),
    directoryState: databases.directory.prepare('SELECT * FROM directory_state').get(),
    projection: databases.directory.prepare('SELECT * FROM directory_projection').get(),
  }
}

export function runOldNewOldFixture(schema = loadPinnedDirectorySchema()) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const databases = { d1: new DatabaseSync(':memory:'), board: new DatabaseSync(':memory:'), directory: new DatabaseSync(':memory:') }
  try {
    databases.d1.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY, state TEXT); INSERT INTO jobs VALUES (61, 'open'); CREATE TABLE checkpoint (chain_id INTEGER PRIMARY KEY, next_block INTEGER); INSERT INTO checkpoint VALUES (10143, 123);")
    databases.board.exec(`CREATE TABLE board_state (id INTEGER PRIMARY KEY, json TEXT); INSERT INTO board_state VALUES (1, '{"board":"preserved"}');`)
    const before = readOldCodeFixture(databases)
    applyAdditiveDirectoryFixture(databases, schema)
    databases.d1.prepare('INSERT INTO directory_agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(10143, '0xregistry', '42'.padStart(78, '0'), '42', 'public', 1, 1, 1700000000, '{"agentId":"42"}')
    databases.directory.prepare('INSERT INTO directory_state VALUES (1, 1, ?)').run('{"generation":1,"accepted":{"Enrollment":{"nonce":1}}}')
    databases.directory.prepare('INSERT INTO directory_projection VALUES (1, ?, 1)').run('{"network":"monad-testnet","audience":"public","agentId":"42"}')
    const during = { old: readOldCodeFixture(databases), new: readNewCodeFixture(databases) }
    applyAdditiveDirectoryFixture(databases, schema)
    const afterRollback = readOldCodeFixture(databases)
    const directoryAfterRollback = readNewCodeFixture(databases)
    return { before, during, afterRollback, directoryAfterRollback, databases }
  } catch (error) {
    for (const database of Object.values(databases)) database.close()
    throw error
  }
}
