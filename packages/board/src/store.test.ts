import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { fromNodeSqlite, migrate } from './index.ts'

describe('store', () => {
  it('migrates idempotently and enforces one listing per termsHash', () => {
    const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
    migrate(sql)
    migrate(sql)
    const insert = () =>
      sql.run(
        'INSERT INTO tasks (id, creator, stack, terms_json, terms_hash, job_id, publish_tx, from_block, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, 0)',
        `t${Math.random()}`,
        '0xc',
        'main',
        '{}',
        '0xhash',
      )
    insert()
    expect(insert).toThrow()
    expect(sql.all<{ n: number }>('SELECT count(*) AS n FROM tasks')[0]?.n).toBe(1)
  })
})

describe('additive migration', () => {
  it('adds a column a table created by an earlier version lacks', () => {
    const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
    sql.run(
      'CREATE TABLE tasks (id TEXT PRIMARY KEY, creator TEXT NOT NULL, stack TEXT NOT NULL, terms_json TEXT NOT NULL, terms_hash TEXT NOT NULL UNIQUE, job_id TEXT, publish_tx TEXT, from_block INTEGER NOT NULL, created_at INTEGER NOT NULL)',
    )
    sql.run("INSERT INTO tasks VALUES ('t1', '0xc', 'main', '{}', '0xh', NULL, NULL, 0, 0)")
    migrate(sql)
    expect(sql.all<{ id: string; screening_json: string | null }>('SELECT id, screening_json FROM tasks')).toEqual([
      { id: 't1', screening_json: null },
    ])
  })
})
