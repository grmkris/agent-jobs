import type { Sql } from './store.ts'

/** Reserved name in the existing Board namespace, outside the public board-slug syntax. */
export const ADMISSION_OBJECT_NAME = '__hosted_admission_v1__'
export const WRITE_LIMITS = { wallet: 60, ip: 240, window: 60 } as const
export const UPGRADE_LIMITS = { wallet: 3, ip: 20, window: 86_400 } as const

export type RateResult = { ok: true } | { ok: false; code: 'rate-limited'; message: string; retryAfter: number }

/** One counter store for all boards, REST and MCP. Call synchronously inside a DO storage transaction. */
export class AdmissionRateLimits {
  constructor(private readonly sql: Sql) {
    sql.run(`CREATE TABLE IF NOT EXISTS admission_counters (
      key TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL
    )`)
    sql.run('CREATE INDEX IF NOT EXISTS admission_counters_expiry ON admission_counters (expires_at)')
  }

  consume(wallet: string | undefined, ipHash: string, tool: string, now: number): RateResult {
    const groups = [{ name: 'write', limits: WRITE_LIMITS }, ...(tool === 'upgrade_account' ? [{ name: 'upgrade', limits: UPGRADE_LIMITS }] : [])]
    const counters = groups.flatMap(({ name, limits }) => [
      { key: `${name}:ip:${ipHash}`, limit: limits.ip, window: limits.window },
      ...(wallet === undefined ? [] : [{ key: `${name}:wallet:${wallet.toLowerCase()}`, limit: limits.wallet, window: limits.window }]),
    ])
    this.sql.run('DELETE FROM admission_counters WHERE expires_at <= ?', now)
    const rows = counters.map(counter => ({ ...counter, row: this.sql.all<{ used: number; expires_at: number }>(
      'SELECT used, expires_at FROM admission_counters WHERE key = ?', counter.key,
    )[0] }))
    const blocked = rows.filter(({ limit, row }) => row !== undefined && row.used >= limit)
    if (blocked.length > 0) return { ok: false, code: 'rate-limited', message: 'hosted write rate limit reached', retryAfter: Math.max(...blocked.map(({ row }) => row!.expires_at - now)) }
    for (const { key, window } of rows) this.sql.run(
      `INSERT INTO admission_counters (key, used, expires_at) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET used = used + 1`, key, now + window,
    )
    return { ok: true }
  }
}
