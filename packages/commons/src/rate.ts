import { RateLimited } from './errors.ts'
import type { SyncSql } from './sql/sync.ts'

export type RateAction = 'post' | 'report_gap' | 'propose_item' | 'support'
const limits: Record<RateAction, readonly [number, number][]> = {
  post: [
    [6, 60_000],
    [120, 86_400_000],
  ],
  report_gap: [[20, 86_400_000]],
  propose_item: [[3, 86_400_000]],
  support: [[30, 3_600_000]],
}
/** Run inside the write transaction: a rejected action must not spend any rate bucket. */
export function takeRate(sql: SyncSql, action: RateAction, address: string, now: number): void {
  for (const [limit, interval] of limits[action]) {
    const key = `${action}:${interval}:${address}`
    const row = sql.all<{ used: number; expires_at: number }>('SELECT * FROM commons_rate WHERE key=?', key)[0]
    if (row !== undefined && row.expires_at > now && row.used >= limit)
      throw new RateLimited({ retryAfter: Math.ceil((row.expires_at - now) / 1000) })
    const used = row !== undefined && row.expires_at > now ? row.used + 1 : 1
    const expiresAt = row !== undefined && row.expires_at > now ? row.expires_at : now + interval
    sql.run(
      'INSERT INTO commons_rate VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET used=excluded.used,expires_at=excluded.expires_at',
      key,
      used,
      expiresAt,
    )
  }
}
