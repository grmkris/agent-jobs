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
