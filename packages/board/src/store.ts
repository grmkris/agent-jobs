/**
 * The board's off-chain records (spec §3 "Off-chain progress"): tasks and their frozen offers, applications,
 * signed selections, activation and submission preparations, sign-in sessions, and the durable operation records of
 * R114-07. Chain facts (funding, activation, settlement) are never stored as truth here: the service reads them
 * from the chain every time.
 *
 * Runs on any synchronous SQLite: Cloudflare Durable Object storage in production (`fromDurableObjectSql`), Node's
 * `node:sqlite` in tests (`fromNodeSqlite`).
 */
export type SqlValue = string | number | null

export interface Sql {
  all<T>(query: string, ...params: SqlValue[]): T[]
  run(query: string, ...params: SqlValue[]): void
}

/** Cloudflare's `SqlStorage` (`ctx.storage.sql`). */
export function fromDurableObjectSql(sql: {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] }
}): Sql {
  return {
    all: <T>(query: string, ...params: SqlValue[]) => sql.exec(query, ...params).toArray() as T[],
    run: (query, ...params) => {
      sql.exec(query, ...params).toArray()
    },
  }
}

/** Node's `DatabaseSync` from `node:sqlite`. */
export function fromNodeSqlite(db: {
  prepare(query: string): { all(...params: SqlValue[]): unknown[]; run(...params: SqlValue[]): unknown }
}): Sql {
  return {
    all: <T>(query: string, ...params: SqlValue[]) => db.prepare(query).all(...params) as T[],
    run: (query, ...params) => {
      db.prepare(query).run(...params)
    },
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    creator TEXT NOT NULL,
    stack TEXT NOT NULL,
    terms_json TEXT NOT NULL,
    terms_hash TEXT NOT NULL UNIQUE,
    job_id TEXT,
    publish_tx TEXT,
    from_block INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    screening_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    worker TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (task_id, worker)
  )`,
  `CREATE TABLE IF NOT EXISTS selections (
    task_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    application_id TEXT NOT NULL,
    worker TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    activate_by INTEGER NOT NULL,
    signature TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, nonce)
  )`,
  `CREATE TABLE IF NOT EXISTS activation_preps (
    task_id TEXT NOT NULL,
    worker TEXT NOT NULL,
    nonce TEXT NOT NULL,
    budget_nonce TEXT NOT NULL,
    budget_deadline INTEGER NOT NULL,
    PRIMARY KEY (task_id, worker)
  )`,
  `CREATE TABLE IF NOT EXISTS deliverables (
    task_id TEXT NOT NULL,
    worker TEXT NOT NULL,
    deliverable_hash TEXT NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    sha TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, deliverable_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS reasons (
    hash TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    status TEXT NOT NULL,
    tx_hash TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS siwe_nonces (
    nonce TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    worker TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    deliverable_hash TEXT NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    sha TEXT NOT NULL,
    deadline INTEGER NOT NULL,
    budget_nonce TEXT NOT NULL,
    submit_nonce TEXT NOT NULL,
    budget_sig TEXT,
    submit_sig TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (task_id, worker, deliverable_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS onchain_submissions (
    task_id TEXT PRIMARY KEY,
    deliverable_hash TEXT NOT NULL,
    tx_hash TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    submission_hash TEXT NOT NULL,
    verifier TEXT NOT NULL,
    conclusion INTEGER NOT NULL,
    tested_sha TEXT NOT NULL,
    checks_json TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // Quote-to-hire (ADR-0004): a request is a board record with nothing escrowed; quotes are private to the
  // publisher and the bidder until the publisher picks one and publishes the ordinary offer.
  `CREATE TABLE IF NOT EXISTS quote_requests (
    id TEXT PRIMARY KEY,
    creator TEXT NOT NULL,
    stack TEXT NOT NULL,
    request_json TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    quote_deadline INTEGER NOT NULL,
    task_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    worker TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    token TEXT NOT NULL,
    amount TEXT NOT NULL,
    note TEXT NOT NULL,
    quote_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (request_id, worker)
  )`,
  `CREATE TABLE IF NOT EXISTS statements (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    author TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // One decision per dispute (task, disputedAt): the first recorded decision is the only one the board relays.
  `CREATE TABLE IF NOT EXISTS rulings (
    task_id TEXT NOT NULL,
    disputed_at INTEGER NOT NULL,
    arbitrator TEXT NOT NULL,
    runner TEXT NOT NULL,
    bundle_hash TEXT NOT NULL,
    for_worker INTEGER NOT NULL,
    slash_loser INTEGER NOT NULL,
    reason_hash TEXT NOT NULL,
    deadline INTEGER NOT NULL,
    nonce TEXT NOT NULL,
    signature TEXT,
    tx_hash TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, disputed_at)
  )`,
  // Which arbiter runner is active for an arbitrator key (plan B2.4: one runner at a time).
  `CREATE TABLE IF NOT EXISTS arbiter_leases (
    arbitrator TEXT PRIMARY KEY,
    runner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_sessions (
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL
  )`,
]

/** Columns added after a table first shipped; applied additively (never a destructive change to board data). */
const ADDED_COLUMNS: ReadonlyArray<[table: string, column: string, type: string]> = [['tasks', 'screening_json', 'TEXT']]

export function migrate(sql: Sql): void {
  for (const statement of SCHEMA) sql.run(statement)
  for (const [table, column, type] of ADDED_COLUMNS) {
    const columns = sql.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)
    if (!columns.includes(column)) sql.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}

export interface TaskRow {
  id: string
  creator: string
  stack: string
  terms_json: string
  terms_hash: string
  job_id: string | null
  publish_tx: string | null
  from_block: number
  created_at: number
  screening_json: string | null
}

export interface ApplicationRow {
  id: string
  task_id: string
  worker: string
  agent_id: string
  note: string
  created_at: number
}

export interface SelectionRow {
  task_id: string
  nonce: string
  application_id: string
  worker: string
  agent_id: string
  activate_by: number
  signature: string | null
  created_at: number
}

export interface CandidateRow {
  id: string
  task_id: string
  worker: string
  agent_id: string
  deliverable_hash: string
  repo: string
  branch: string
  sha: string
  deadline: number
  budget_nonce: string
  submit_nonce: string
  budget_sig: string | null
  submit_sig: string | null
  created_at: number
}

export interface OperationRow {
  id: string
  task_id: string
  kind: string
  actor: string
  status: 'prepared' | 'submitted' | 'confirmed' | 'failed'
  tx_hash: string | null
  detail: string | null
  created_at: number
  updated_at: number
}

export interface RulingRow {
  task_id: string
  disputed_at: number
  arbitrator: string
  runner: string
  bundle_hash: string
  for_worker: number
  slash_loser: number
  reason_hash: string
  deadline: number
  nonce: string
  signature: string | null
  tx_hash: string | null
  created_at: number
}

export interface QuoteRequestRow {
  id: string
  creator: string
  stack: string
  request_json: string
  request_hash: string
  quote_deadline: number
  task_id: string | null
  created_at: number
}

export interface QuoteRow {
  id: string
  request_id: string
  worker: string
  agent_id: string
  token: string
  amount: string
  note: string
  quote_hash: string
  created_at: number
}
