import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { sql, targetBlock, rewindCheckpoint } from './indexer-cutover.mjs'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE checkpoint(chain_id INTEGER PRIMARY KEY,next_block INTEGER,block_hash TEXT,updated_at INTEGER);
    CREATE TABLE lease(id TEXT PRIMARY KEY,holder TEXT,expires_at INTEGER);
    CREATE TABLE events(id TEXT PRIMARY KEY); CREATE TABLE protocol_events(id TEXT PRIMARY KEY); CREATE TABLE jobs(id TEXT PRIMARY KEY);
    INSERT INTO checkpoint VALUES(10143,69000000,'0xabc',42);
    INSERT INTO events VALUES('archived'); INSERT INTO protocol_events VALUES('g1b'); INSERT INTO jobs VALUES('82');`)
  const query = async (statement, params = []) => {
    const prepared = db.prepare(statement)
    if (statement.startsWith('SELECT')) return { results: prepared.all(...params) }
    return { results: [], changes: prepared.run(...params).changes }
  }
  return { db, query }
}

test('checkpoint-only rewind preserves facts and jobs, releases owned lease, and replay is a no-op', async () => {
  const { db, query } = fixture()
  try {
    const result = await rewindCheckpoint(query, 68900000, 'owner', async () => {})
    assert.equal(result.changed, true)
    assert.deepEqual({ ...result.checkpoint }, { chain_id: 10143, next_block: 68900000, block_hash: null, updated_at: 0 })
    for (const table of ['events', 'protocol_events', 'jobs']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 1)
    assert.equal((await query(sql.lease)).results[0].holder, 'owner')
    assert.equal((await rewindCheckpoint(query, 68900000, 'retry', async () => {})).changed, false)
  } finally { db.close() }
})

test('live lease prevents rewind and is never released by the contender', async () => {
  const { db, query } = fixture()
  try {
    db.exec("INSERT INTO lease VALUES('indexer:10143','other',strftime('%s','now')+300)")
    await assert.rejects(rewindCheckpoint(query, 68900000, 'owner', async () => {}), /another runner/)
    assert.equal((await query(sql.lease)).results[0].holder, 'other')
    assert.equal((await query(sql.checkpoint)).results[0].next_block, 69000000)
  } finally { db.close() }
})

test('CAS refuses a concurrent checkpoint change and expired lease', () => {
  const { db } = fixture()
  try {
    db.prepare(sql.acquire).run('owner')
    const params = [68900000, 69000000, '0xabc', 42, 68900000, 'owner']
    db.exec('UPDATE checkpoint SET updated_at=43')
    assert.equal(db.prepare(sql.rewind).run(...params).changes, 0)
    db.exec('UPDATE checkpoint SET updated_at=42; UPDATE lease SET expires_at=0')
    assert.equal(db.prepare(sql.rewind).run(...params).changes, 0)
  } finally { db.close() }
})

test('config mutation refuses before rewind and releases only owned lease', async () => {
  const { db, query } = fixture()
  try {
    await assert.rejects(rewindCheckpoint(query, 68900000, 'owner', async () => { throw new Error('changed') }), /changed/)
    assert.equal((await query(sql.checkpoint)).results[0].next_block, 69000000)
    db.exec("UPDATE lease SET holder='successor',expires_at=strftime('%s','now')+300")
    assert.equal(db.prepare(sql.release).run('owner').changes, 0)
  } finally { db.close() }
})

test('G1b/mainnet/wrong expected block refuse', () => {
  const config = { network: 'monad-testnet', chainId: 10143, deployment: { sidequest: { block: 68900000, vault: '0x1111111111111111111111111111111111111111' }, main: { kind: 'sidequest-v1' } } }
  assert.equal(targetBlock(config, 68900000), 68900000)
  assert.throws(() => targetBlock(config, 68800000), /expect-block/)
  assert.throws(() => targetBlock({ ...config, chainId: 143 }), /G1c/)
  assert.throws(() => targetBlock({ ...config, deployment: { ...config.deployment, sidequest: { ...config.deployment.sidequest, block: 67856884 } } }), /G1c/)
})
