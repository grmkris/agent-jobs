import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrateAgentSchema, retireFleetSchema, RETIRED_FLEET_TABLES } from './agent-schema.ts'
import { fromNodeSqlite } from './store.ts'

describe('agent-first clean break', () => {
  it('drops old authority once and preserves every pending relay ledger across restart', () => {
    const db = new DatabaseSync(':memory:')
    const sql = fromNodeSqlite(db)
    for (const table of [...RETIRED_FLEET_TABLES, 'sponsor_operations', 'sponsor_replacements', 'relay_operations']) {
      db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`)
      db.prepare(`INSERT INTO ${table} VALUES (?)`).run('pending-original')
    }
    migrateAgentSchema(sql)
    for (const table of [...RETIRED_FLEET_TABLES, 'sponsor_grants']) {
      expect(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table)).toBeUndefined()
    }
    db.prepare('INSERT INTO grants VALUES (?,?,?,?,?,?,?,?,?)').run(
      'hash',
      'operator',
      'operator',
      'relay',
      'operator',
      '{}',
      null,
      'prepared',
      100,
    )
    migrateAgentSchema(sql)
    expect(db.prepare('SELECT delegation_hash FROM grants').all()).toEqual([{ delegation_hash: 'hash' }])
    for (const table of ['sponsor_operations', 'sponsor_replacements', 'relay_operations']) {
      expect(db.prepare(`SELECT id FROM ${table}`).all()).toEqual([{ id: 'pending-original' }])
    }
    db.close()
  })

  it('rolls back a failed drop and never records an incomplete version', () => {
    const db = new DatabaseSync(':memory:')
    const sql = fromNodeSqlite(db)
    db.exec(
      "CREATE TABLE sponsor_grants (id TEXT); INSERT INTO sponsor_grants VALUES ('original'); CREATE TABLE grants (conflict TEXT)",
    )
    expect(() => migrateAgentSchema(sql)).toThrow()
    expect(db.prepare('SELECT id FROM sponsor_grants').all()).toEqual([{ id: 'original' }])
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='schema_versions'").get()).toBeUndefined()
    db.close()
  })

  it('retires the old fleet object without creating a second management store', () => {
    const db = new DatabaseSync(':memory:')
    const sql = fromNodeSqlite(db)
    for (const table of RETIRED_FLEET_TABLES) db.exec(`CREATE TABLE ${table} (id TEXT)`)
    retireFleetSchema(sql)
    retireFleetSchema(sql)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'schema_versions' }])
    db.close()
  })
})
