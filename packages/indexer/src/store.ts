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
    all: async <T>(query: string, ...params: SqlValue[]) =>
      (
        await db
          .prepare(query)
          .bind(...params)
          .all<T>()
      ).results,
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

/** Runtime schema. v1 changes are additive; the release guard permits no D1 migration files. */
export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS checkpoint (
    chain_id INTEGER PRIMARY KEY,
    next_block INTEGER NOT NULL,
    block_hash TEXT,
    core_address TEXT,
    deployment_block INTEGER,
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
  `CREATE TABLE IF NOT EXISTS protocol_events (
    chain_id INTEGER NOT NULL,
    contract TEXT NOT NULL,
    block INTEGER NOT NULL,
    log_index INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    args_json TEXT NOT NULL,
    PRIMARY KEY (chain_id, contract, block, log_index)
  )`,
  'CREATE INDEX IF NOT EXISTS protocol_events_block ON protocol_events (chain_id, block, log_index)',
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
    manifest_hash TEXT,
    delivery_deadline INTEGER,
    selection_deadline INTEGER,
    worker TEXT,
    agent_id TEXT,
    status TEXT NOT NULL,
    deliverable TEXT,
    violation TEXT,
    rejection_reason_hash TEXT,
    kind TEXT,
    arbitrator TEXT,
    expired_at INTEGER,
    review_window INTEGER,
    dispute_window INTEGER,
    arbitration_window INTEGER,
    fee_bps INTEGER,
    fee TEXT,
    net TEXT,
    bonus TEXT,
    outcome TEXT,
    settlement_outcome TEXT,
    charged_fee TEXT,
    bonus_fee TEXT,
    payout_deferred INTEGER,
    refund_deferred INTEGER,
    refunded_to_holding INTEGER,
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
  `CREATE TABLE IF NOT EXISTS top_ups (
    chain_id INTEGER NOT NULL,
    job_id TEXT NOT NULL,
    block INTEGER NOT NULL,
    log_index INTEGER NOT NULL,
    contributor TEXT NOT NULL,
    amount TEXT NOT NULL,
    refunded INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    PRIMARY KEY (chain_id, job_id, block, log_index)
  )`,
  `CREATE TABLE IF NOT EXISTS fee_charges (
    chain_id INTEGER NOT NULL,
    job_id TEXT NOT NULL,
    block INTEGER NOT NULL,
    log_index INTEGER NOT NULL,
    token TEXT NOT NULL,
    worker TEXT NOT NULL,
    creator TEXT NOT NULL,
    amount TEXT NOT NULL,
    bonus_part TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    PRIMARY KEY (chain_id, job_id, block, log_index)
  )`,
  `CREATE TABLE IF NOT EXISTS payout_owed (
    chain_id INTEGER NOT NULL,
    job_id TEXT NOT NULL,
    block INTEGER NOT NULL,
    log_index INTEGER NOT NULL,
    recipient TEXT NOT NULL,
    token TEXT NOT NULL,
    amount TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    PRIMARY KEY (chain_id, job_id, block, log_index)
  )`,
  `CREATE TABLE IF NOT EXISTS foreign_offers (
    terms_hash TEXT PRIMARY KEY,
    origin TEXT NOT NULL,
    body TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS foreign_offer_misses (
    terms_hash TEXT NOT NULL,
    origin TEXT NOT NULL,
    retry_after INTEGER NOT NULL,
    PRIMARY KEY (terms_hash, origin)
  )`,
  `CREATE TABLE IF NOT EXISTS foreign_offer_budget (
    chain_id INTEGER PRIMARY KEY,
    window_start INTEGER NOT NULL,
    attempts INTEGER NOT NULL
  )`,
  // Agent pages look jobs up by agent and by worker wallet (viem checksums addresses; lookups compare lowercased).
  'CREATE INDEX IF NOT EXISTS jobs_agent ON jobs (chain_id, agent_id)',
  'CREATE INDEX IF NOT EXISTS jobs_worker ON jobs (chain_id, lower(worker))',
  // An agent's hiring: the jobs its wallets posted (`agentDetail`).
  'CREATE INDEX IF NOT EXISTS jobs_creator ON jobs (chain_id, lower(creator))',
  // Unix times of the blocks events are in, for job timelines. Chain facts of finalized blocks: never folded, and
  // kept across a rewind or rebuild, since a finalized block's time does not change.
  `CREATE TABLE IF NOT EXISTS block_times (
    chain_id INTEGER NOT NULL,
    block INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    PRIMARY KEY (chain_id, block)
  )`,
]

/** Tables folded from events: a job's rows here are always replaced together from its events. */
export const DERIVED_TABLES = [
  'jobs',
  'submissions',
  'evidence',
  'rulings',
  'reward_outcomes',
  'bond_outcomes',
  'feedback',
  'top_ups',
  'fee_charges',
  'payout_owed',
] as const

export async function migrate(sql: AsyncSql): Promise<void> {
  await sql.batch(SCHEMA.map((q) => stmt(q)))
  await migrateCheckpoint(sql)
  // D1 has no migration runner in v1. Existing installations receive only additive columns at runtime;
  // no data is rewritten and no destructive migration is possible through this path.
  const columns: readonly [string, string][] = [
    ['manifest_hash', 'TEXT'],
    ['arbitrator', 'TEXT'],
    ['expired_at', 'INTEGER'],
    ['review_window', 'INTEGER'],
    ['dispute_window', 'INTEGER'],
    ['arbitration_window', 'INTEGER'],
    ['kind', 'TEXT'],
    ['fee_bps', 'INTEGER'],
    ['fee', 'TEXT'],
    ['net', 'TEXT'],
    ['bonus', 'TEXT'],
    ['outcome', 'TEXT'],
    ['settlement_outcome', 'TEXT'],
    ['charged_fee', 'TEXT'],
    ['bonus_fee', 'TEXT'],
    ['payout_deferred', 'INTEGER'],
    ['refund_deferred', 'INTEGER'],
    ['refunded_to_holding', 'INTEGER'],
  ]
  const present = new Set((await sql.all<{ name: string }>('PRAGMA table_info(jobs)')).map((c) => c.name))
  const missing = columns.filter(([name]) => !present.has(name))
  if (missing.length > 0) {
    try {
      await sql.batch(missing.map(([name, type]) => stmt(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`)))
    } catch (error) {
      // API and cron can initialize together. A competing successful initializer is the only ignored failure.
      const after = new Set((await sql.all<{ name: string }>('PRAGMA table_info(jobs)')).map((c) => c.name))
      if (missing.some(([name]) => !after.has(name))) throw error
    }
  }
}

async function migrateCheckpoint(sql: AsyncSql): Promise<void> {
  const checkpointColumns = new Set(
    (await sql.all<{ name: string }>('PRAGMA table_info(checkpoint)')).map((c) => c.name),
  )
  const missingCheckpoint = (
    [
      ['core_address', 'TEXT'],
      ['deployment_block', 'INTEGER'],
    ] as const
  ).filter(([name]) => !checkpointColumns.has(name))
  if (missingCheckpoint.length > 0) {
    try {
      await sql.batch(
        missingCheckpoint.map(([name, type]) => stmt(`ALTER TABLE checkpoint ADD COLUMN ${name} ${type}`)),
      )
    } catch (error) {
      const after = new Set((await sql.all<{ name: string }>('PRAGMA table_info(checkpoint)')).map((c) => c.name))
      if (missingCheckpoint.some(([name]) => !after.has(name))) throw error
    }
  }
}
