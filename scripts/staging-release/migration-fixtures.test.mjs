import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyAdditiveDirectoryFixture, loadPinnedDirectorySchema, migrationManifest, pinnedSourceRoot, readNewCodeFixture, runOldNewOldFixture, sourceHashes, validateMigrationFixtureManifest } from './migration-fixtures.mjs'

const track = dirname(fileURLToPath(import.meta.url))

test('offline manifest requires unresolved namespace/tag and existing D1 alias', () => {
  assert.deepEqual(validateMigrationFixtureManifest(), { ok: true, blockers: [], applyAuthorized: false })
})

test('old-reader/new-schema/old-reader preserves separate D1, Board and directory SQLite fixtures', () => {
  const result = runOldNewOldFixture()
  try {
    assert.deepEqual(result.before, result.afterRollback)
    assert.deepEqual(result.during.old, result.before)
    assert.deepEqual(result.during.new, result.directoryAfterRollback)
    assert.equal(result.during.old.job61.state, 'open')
    assert.equal(result.during.old.checkpoint.next_block, 123)
    assert.equal(result.during.old.board.json, '{"board":"preserved"}')
    assert.equal(result.during.new.directory.agent_id, '42')
    assert.deepEqual(JSON.parse(result.during.new.directoryState.json), { generation: 1, accepted: { Enrollment: { nonce: 1 } } })
    assert.equal(result.during.new.projection.revision, 1)
    assert.equal(result.databases.board.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'directory_%'").get().count, 0)
    assert.equal(result.databases.d1.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('directory_state', 'directory_projection')").get().count, 0)
  } finally {
    for (const database of Object.values(result.databases)) database.close()
  }
})

test('real SQLite enforces the pinned directory composite primary key', () => {
  const result = runOldNewOldFixture()
  try {
    const database = result.databases.d1
    const primaryKeys = database.prepare('PRAGMA table_info(directory_agents)').all().filter((column) => column.pk).sort((left, right) => left.pk - right.pk).map((column) => column.name)
    assert.deepEqual(primaryKeys, ['chain_id', 'registry', 'audience', 'agent_key'])
    assert.throws(() => database.exec('INSERT INTO directory_agents SELECT * FROM directory_agents'), /UNIQUE constraint failed/)
    for (const [column, value] of [['chain_id', '1'], ['registry', "'0xother'"], ['audience', "'private'"], ['agent_key', "'other-agent'"]]) {
      const columns = database.prepare('PRAGMA table_info(directory_agents)').all().map((entry) => entry.name)
      const selection = columns.map((name) => name === column ? value : name).join(', ')
      database.exec(`INSERT INTO directory_agents SELECT ${selection} FROM directory_agents LIMIT 1`)
    }
    assert.equal(database.prepare('SELECT count(*) AS count FROM directory_agents').get().count, 5)
    assert.equal(readNewCodeFixture(result.databases).directory.agent_id, '42')
  } finally {
    for (const database of Object.values(result.databases)) database.close()
  }
})

test('injected SQL and schema drift are rejected before executing any fixture statement', () => {
  const result = runOldNewOldFixture()
  const pinned = loadPinnedDirectorySchema()
  try {
    for (const schema of [
      { ...pinned, d1: 'DROP TABLE jobs' },
      { ...pinned, state: `${pinned.state}; DELETE FROM directory_state` },
      { ...pinned, journal: 'CREATE TABLE unexpected (id INTEGER)' },
      { ...pinned, hidden: 'DROP TABLE checkpoint' },
      { ...pinned, applyAuthorized: true },
      null,
    ]) assert.throws(() => applyAdditiveDirectoryFixture(result.databases, schema), /pinned-schema-drift/)
    assert.deepEqual(result.databases.d1.prepare('SELECT * FROM jobs').all().map((row) => ({ ...row })), [{ id: 61, state: 'open' }])
    assert.equal(result.databases.directory.prepare('SELECT count(*) AS count FROM directory_state').get().count, 1)
    assert.equal(result.databases.directory.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'unexpected'").get().count, 0)
  } finally {
    for (const database of Object.values(result.databases)) database.close()
  }
})

test('source hash drift stops before any fixture SQL is executed', () => {
  const root = mkdtempSync(join(track, '.source-fixture-'))
  try {
    for (const name of Object.keys(sourceHashes)) {
      const path = join(root, name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, readFileSync(join(pinnedSourceRoot, name)))
    }
    assert.ok(loadPinnedDirectorySchema(root).d1.includes('CREATE TABLE IF NOT EXISTS directory_agents'))
    writeFileSync(join(root, 'apps/api/src/directory.ts'), 'DROP TABLE jobs;')
    assert.throws(() => loadPinnedDirectorySchema(root), /pinned-source-drift/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('unapproved source roots are refused without reading source or secrets', () => {
  for (const root of ['/etc', '/home/kristjan/.config', track, null]) assert.throws(() => loadPinnedDirectorySchema(root), /source-root-refused/)
})

for (const [name, mutate, blocker] of [
  ['wrong source class', (manifest) => { manifest.className = 'Board' }, 'directory-class-export-mismatch'],
  ['wrong compiled export', (manifest) => { manifest.compiledExportRequired = 'default' }, 'directory-class-export-mismatch'],
  ['duplicate namespace', (manifest) => { manifest.namespaceId = 'a4ec9b59cf39484f81e8ecf0c5f3eb9f' }, 'namespace-preassigned'],
  ['new migration tag', (manifest) => { manifest.migrationTag = 'directory-v1' }, 'migration-tag-unreviewed'],
  ['unverified prior tag claimed verified', (manifest) => { manifest.priorTagVerified = true }, 'migration-tag-unreviewed'],
  ['duplicate D1 alias', (manifest) => { manifest.bindings.DIRECTORY_DATABASE = '2118683d-748c-4987-857e-f933ab756c74' }, 'directory-d1-alias-mismatch'],
  ['wrong D1', (manifest) => { manifest.existingDatabaseId = 'duplicate' }, 'existing-d1-mismatch'],
  ['wrong primary key', (manifest) => { manifest.d1PrimaryKey = '(agent_key)' }, 'directory-primary-key-mismatch'],
  ['wrong DO schema', (manifest) => { manifest.durableObjectTables = ['board_state'] }, 'directory-do-schema-mismatch'],
  ['destructive operation', (manifest) => { manifest.destructiveOperations = ['DROP TABLE jobs'] }, 'destructive-migration'],
  ['hidden migration', (manifest) => { manifest.hiddenSql = 'DROP TABLE jobs' }, 'undeclared-migration-operation'],
]) {
  test(`rejects ${name}`, () => {
    const candidate = { ...migrationManifest, bindings: { ...migrationManifest.bindings }, destructiveOperations: [...migrationManifest.destructiveOperations] }
    mutate(candidate)
    const result = validateMigrationFixtureManifest(candidate)
    assert.equal(result.ok, false)
    assert.equal(result.applyAuthorized, false)
    assert.ok(result.blockers.includes(blocker))
  })
}

test('malformed migration manifests fail closed', () => {
  for (const manifest of [null, undefined, {}, [], 'private-input', Object.create(migrationManifest), { ...migrationManifest, bindings: Object.create(migrationManifest.bindings) }]) {
    const result = validateMigrationFixtureManifest(manifest ?? (manifest === undefined ? {} : manifest))
    assert.equal(result.ok, false)
    assert.equal(result.applyAuthorized, false)
    assert.ok(!JSON.stringify(result).includes('private-input'))
  }
})

test('migration direct input rejects custom prototypes even with all declared own fields', () => {
  for (const manifest of [
    Object.assign(Object.create({ hidden: 'untrusted-marker' }), migrationManifest),
    { ...migrationManifest, bindings: Object.assign(Object.create({ hidden: 'untrusted-marker' }), migrationManifest.bindings) },
  ]) {
    const result = validateMigrationFixtureManifest(manifest)
    assert.equal(result.ok, false)
    assert.equal(result.applyAuthorized, false)
    assert.ok(!JSON.stringify(result).includes('untrusted-marker'))
  }
  const manifest = Object.assign(Object.create(null), migrationManifest)
  manifest.bindings = Object.assign(Object.create(null), migrationManifest.bindings)
  assert.equal(validateMigrationFixtureManifest(manifest).ok, true)
})
