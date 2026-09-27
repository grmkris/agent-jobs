/**
 * The indexer's D1 tables (spec §5 `apps/indexer`): decoded events keyed by `(chainId, contract, block, logIndex)`,
 * and the chain facts Explore reads, each folded from a job's events alone, so a replayed page, a restart and a
 * full rebuild all produce the same rows. The indexer is the only writer.
 *
 * `AsyncSql` fits D1 (`fromD1`) and Node's `node:sqlite` in tests (`fromNodeSqlite`); `batch` is atomic in both.
 */
export type SqlValue = string | number | null

export interface Statement {
  readonly query: string
  readonly params: readonly SqlValue[]
}

export interface AsyncSql {
  all<T>(query: string, ...params: SqlValue[]): Promise<T[]>
  /** All statements commit together or none does. */
  batch(statements: readonly Statement[]): Promise<void>
}

export const stmt = (query: string, ...params: SqlValue[]): Statement => ({ query, params })

/** Cloudflare D1 (`env.DB`). */
export function fromD1(db: {
  prepare(query: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> } }
  batch(statements: unknown[]): Promise<unknown>
}): AsyncSql {
  return {
    all: async <T>(query: string, ...params: SqlValue[]) => (await db.prepare(query).bind(...params).all<T>()).results,
    batch: async (statements) => {
      if (statements.length === 0) return
      await db.batch(statements.map((s) => db.prepare(s.query).bind(...s.params)))
    },
  }
}

/** Node's `DatabaseSync` (tests). */
export function fromNodeSqlite(db: {
  exec(sql: string): void
  prepare(query: string): { all(...params: SqlValue[]): unknown[]; run(...params: SqlValue[]): unknown }
}): AsyncSql {
  return {
    all: async <T>(query: string, ...params: SqlValue[]) => db.prepare(query).all(...params) as T[],
    batch: async (statements) => {
      db.exec('BEGIN')
      try {
        for (const s of statements) db.prepare(s.query).run(...s.params)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  }
}

/** The schema, also shipped as `apps/indexer/migrations/0001_init.sql` for D1. */
export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS checkpoint (
    chain_id INTEGER PRIMARY KEY,
    next_block INTEGER NOT NULL,
    block_hash TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS lease (
    id TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    chain_id INTEGER NOT NULL,
    contract TEXT NOT NULL,
    block INTEGER NOT NULL,
    log_index INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    job_id TEXT,
    name TEXT NOT NULL,
    args_json TEXT NOT NULL,
    PRIMARY KEY (chain_id, contract, block, log_index)
  )`,
  'CREATE INDEX IF NOT EXISTS events_job ON events (chain_id, job_id, block, log_index)',
  `CREATE TABLE IF NOT EXISTS jobs (
    chain_id INTEGER NOT NULL,
    job_id TEXT NOT NULL,
    stack TEXT,
    mode TEXT,
    creator TEXT,
    approver TEXT,
    token TEXT,
    reward TEXT,
    creator_bond TEXT,
    worker_bond TEXT,
    policy_hash TEXT,
    delivery_deadline INTEGER,
    selection_deadline INTEGER,
    worker TEXT,
    agent_id TEXT,
    status TEXT NOT NULL,
    deliverable TEXT,
    violation TEXT,
    rejection_reason_hash TEXT,
    published_block INTEGER,
    published_tx TEXT,
    updated_block INTEGER NOT NULL,
    PRIMARY KEY (chain_id, job_id)
  )`,
  `CREATE TABLE IF NOT EXISTS submissions (
    chain_id INTEGER NOT NULL,
    job_id TEXT NOT NULL,
    deliverable TEXT NOT NULL,
    provider TEXT NOT NULL,
    block INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    PRIMARY KEY (chain_id, job_id)
  )`,
  `CREATE TABLE IF NOT EXISTS evidence (
    chain_id INTEGER NOT NULL,
    job_id TEXT NOT NULL,
    block INTEGER NOT NULL,
    log_index INTEGER NOT NULL,
    verifier TEXT NOT NULL,
    digest TEXT NOT NULL,
    submission_hash TEXT NOT NULL,
    policy_hash TEXT NOT NULL,
    tested_sha TEXT NOT NULL,
    conclusion INTEGER NOT NULL,
    valid_until INTEGER NOT NULL,
    matches_onchain INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    PRIMARY KEY (chain_id, job_id, block, log_index)
  )`,
  `CREATE TABLE IF NOT EXISTS rulings (
    chain_id INTEGER NOT NULL,
    job_id TEXT NOT NULL,
    for_worker INTEGER NOT NULL,
    slash_loser INTEGER NOT NULL,
    reason_hash TEXT NOT NULL,
    block INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    PRIMARY KEY (chain_id, job_id)
  )`,
  `CREATE TABLE IF NOT EXISTS reward_outcomes (
    chain_id INTEGER NOT NULL,
    job_id TEXT NOT NULL,
    block INTEGER NOT NULL,
    log_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    recipient TEXT NOT NULL,
    amount TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    PRIMARY KEY (chain_id, job_id, block, log_index)
  )`,
  `CREATE TABLE IF NOT EXISTS bond_outcomes (
    chain_id INTEGER NOT NULL,
    job_id TEXT NOT NULL,
    block INTEGER NOT NULL,
    log_index INTEGER NOT NULL,
    side TEXT NOT NULL,
    outcome TEXT NOT NULL,
    recipient TEXT,
    amount TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    PRIMARY KEY (chain_id, job_id, block, log_index)
  )`,
  `CREATE TABLE IF NOT EXISTS feedback (
    chain_id INTEGER NOT NULL,
    job_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    value TEXT,
    tag TEXT,
    recorded INTEGER NOT NULL,
    block INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    PRIMARY KEY (chain_id, job_id)
  )`,
]

/** Tables folded from events: a job's rows here are always replaced together from its events. */
export const DERIVED_TABLES = ['jobs', 'submissions', 'evidence', 'rulings', 'reward_outcomes', 'bond_outcomes', 'feedback'] as const

export async function migrate(sql: AsyncSql): Promise<void> {
  await sql.batch(SCHEMA.map((q) => stmt(q)))
}
