import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import type { SyncSql } from '../src/sql/sync.ts'

export const testSql = Effect.fnUntraced(function* () {
  const database = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(':memory:')),
    (handle) => Effect.sync(() => handle.close()),
  )
  const sql: SyncSql = {
    all: <T>(q: string, ...p: (string | number | null)[]) => {
      // SAFETY: SQLite returns the columns selected by the caller's query; JSON columns are Schema decoded separately.
      return database.prepare(q).all(...p) as T[]
    },
    run: (q, ...p) => {
      database.prepare(q).run(...p)
    },
  }
  const transaction = <A>(f: () => A): A => {
    database.exec('SAVEPOINT commons_test')
    try {
      const value = f()
      database.exec('RELEASE commons_test')
      return value
    } catch (error) {
      database.exec('ROLLBACK TO commons_test')
      database.exec('RELEASE commons_test')
      throw error
    }
  }
  return { sql, transaction }
})
