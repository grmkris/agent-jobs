import { Layer } from 'effect'
import { CommonsSql } from '../services.ts'

export type SqlValue = string | number | null
export interface SyncSql {
  all<T>(q: string, ...p: SqlValue[]): T[]
  run(q: string, ...p: SqlValue[]): void
}
export const sqlLayer = (sync: SyncSql, transaction: <A>(f: () => A) => A) =>
  Layer.succeed(CommonsSql, {
    all: <T>(q: string, ...p: SqlValue[]) => sync.all<T>(q, ...p),
    run: (q, ...p) => sync.run(q, ...p),
    transaction: <A>(f: (sql: SyncSql) => A) => transaction(() => f(sync)),
  })
