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

describe('ADR-0005 budgets are retired (ADR-0009)', () => {
  it('drops the old budget tables and removes tasks frozen with an old budget shape, with what hangs off them', () => {
    const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
    sql.run('CREATE TABLE budget_grants (task_id TEXT PRIMARY KEY)')
    migrate(sql)
    const task = (id: string, budget: unknown) =>
      sql.run(
        'INSERT INTO tasks (id, creator, stack, terms_json, terms_hash, job_id, publish_tx, from_block, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, 0)',
        id, '0xc', 'main', JSON.stringify(budget === undefined ? {} : { executionBudget: budget }), `0x${id}`,
      )
    task('none', undefined)
    task('token', { token: '0x7', cap: '1', expiresAt: 1 })
    task('x402', { kind: 'x402', token: '0x7', cap: '1', perCall: '1', expiresAt: 1 })
    task('advance', { kind: 'advance', token: '0x7', cap: '1', expiresAt: 1 })
    sql.run("INSERT INTO operations (id, task_id, kind, actor, status, tx_hash, detail, created_at, updated_at) VALUES ('o1', 'token', 'publish', '0xc', 'prepared', NULL, NULL, 0, 0)")
    migrate(sql)
    expect(sql.all<{ id: string }>('SELECT id FROM tasks ORDER BY id').map((r) => r.id)).toEqual(['advance', 'none'])
    expect(sql.all('SELECT id FROM operations')).toEqual([])
    expect(sql.all("SELECT name FROM sqlite_master WHERE name IN ('budget_wallets', 'budget_grants', 'budget_spends')")).toEqual([])
  })
})

it('commits a hosted preparation and retry result together, and rolls both back on an interrupted write', () => {
  const db = new DatabaseSync(':memory:'), sql = fromNodeSqlite(db)
  try {
    migrate(sql)
    const remember = () => sql.run('INSERT INTO hosted_idempotency VALUES (?,?,?,?,?)', 'wallet', 'create_task', 'key', '{"taskId":"task"}', 1)
    expect(() => sql.atomic!(() => { remember(); throw new Error('crash before completion') })).toThrow('crash')
    expect(sql.all('SELECT * FROM hosted_idempotency')).toEqual([])
    sql.atomic!(remember)
    expect(sql.all('SELECT action_key,result_json FROM hosted_idempotency')).toEqual([{ action_key: 'key', result_json: '{"taskId":"task"}' }])
  } finally { db.close() }
})
