/**
 * The board registry (ADR-0008): which tenant boards exist and what they offer, which frozen offers belong to which
 * board (`terms_hash` = the listing's `policyHash`, so chain jobs are attributed without a board field on-chain), and
 * the once-per-address MON drips. Lives in the API's D1 next to the indexer's chain facts; the API Worker is the only
 * writer of these tables, the indexer of its own.
 */
import type { TenantConfig } from '@agent-jobs/board'
import { type AsyncSql, type JobRow, stmt } from '@agent-jobs/indexer'

export const REGISTRY_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner TEXT NOT NULL,
    config_json TEXT NOT NULL,
    webhook_secret TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS board_offers (
    terms_hash TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS board_offers_board ON board_offers (board_id, created_at)',
  `CREATE TABLE IF NOT EXISTS drips (
    board_id TEXT NOT NULL,
    address TEXT NOT NULL,
    token TEXT NOT NULL,
    status TEXT NOT NULL,
    tx_hash TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, address)
  )`,
]

export async function migrateRegistry(sql: AsyncSql): Promise<void> {
  await sql.batch(REGISTRY_SCHEMA.map((q) => stmt(q)))
}

interface BoardRow {
  id: string
  name: string
  owner: string
  config_json: string
  webhook_secret: string | null
  created_at: number
  updated_at: number
}

export interface StoredBoard {
  readonly config: TenantConfig
  readonly webhookSecret: string | null
}

const parse = (r: BoardRow): StoredBoard => ({ config: JSON.parse(r.config_json) as TenantConfig, webhookSecret: r.webhook_secret })

export async function getBoard(sql: AsyncSql, id: string): Promise<StoredBoard | undefined> {
  const [row] = await sql.all<BoardRow>('SELECT * FROM boards WHERE id = ?', id)
  return row === undefined ? undefined : parse(row)
}

export async function listBoards(sql: AsyncSql): Promise<TenantConfig[]> {
  return (await sql.all<BoardRow>('SELECT * FROM boards ORDER BY created_at')).map((r) => parse(r).config)
}

/** Inserts a board; false when the slug is taken. */
export async function createBoard(sql: AsyncSql, config: TenantConfig, webhookSecret: string | null, now: number): Promise<boolean> {
  if ((await getBoard(sql, config.id)) !== undefined) return false
  await sql.batch([
    stmt(
      'INSERT INTO boards (id, name, owner, config_json, webhook_secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      config.id, config.name, config.owner ?? '', JSON.stringify(config), webhookSecret, now, now,
    ),
  ])
  return true
}

export async function updateBoard(sql: AsyncSql, config: TenantConfig, webhookSecret: string | null | undefined, now: number): Promise<void> {
  await sql.batch([
    webhookSecret === undefined
      ? stmt('UPDATE boards SET name = ?, config_json = ?, updated_at = ? WHERE id = ?', config.name, JSON.stringify(config), now, config.id)
      : stmt('UPDATE boards SET name = ?, config_json = ?, webhook_secret = ?, updated_at = ? WHERE id = ?', config.name, JSON.stringify(config), webhookSecret, now, config.id),
  ])
}

/** Attributes a frozen offer (its terms hash is the listing's policyHash) to the board it was created on. */
export async function recordOffer(sql: AsyncSql, input: { boardId: string; termsHash: string; taskId: string; now: number }): Promise<void> {
  await sql.batch([stmt('INSERT OR IGNORE INTO board_offers (terms_hash, board_id, task_id, created_at) VALUES (?, ?, ?, ?)', input.termsHash.toLowerCase(), input.boardId, input.taskId, input.now)])
}

export async function boardOfTerms(sql: AsyncSql, termsHash: string): Promise<{ boardId: string; taskId: string } | undefined> {
  const [row] = await sql.all<{ board_id: string; task_id: string }>('SELECT board_id, task_id FROM board_offers WHERE terms_hash = ?', termsHash.toLowerCase())
  return row === undefined ? undefined : { boardId: row.board_id, taskId: row.task_id }
}

export type JobWithBoard = JobRow & { board_id: string | null }

/** Chain jobs with the board each offer belongs to (null: published outside any hosted board). */
export async function jobsWithBoards(sql: AsyncSql, chainId: number, limit = 200): Promise<JobWithBoard[]> {
  return sql.all<JobWithBoard>(
    'SELECT j.*, o.board_id FROM jobs j LEFT JOIN board_offers o ON lower(j.policy_hash) = o.terms_hash WHERE j.chain_id = ? ORDER BY CAST(j.job_id AS INTEGER) DESC LIMIT ?',
    chainId, limit,
  )
}

export async function jobsOfBoard(sql: AsyncSql, chainId: number, boardId: string, limit = 200): Promise<JobWithBoard[]> {
  return sql.all<JobWithBoard>(
    'SELECT j.*, o.board_id FROM jobs j JOIN board_offers o ON lower(j.policy_hash) = o.terms_hash WHERE j.chain_id = ? AND o.board_id = ? ORDER BY CAST(j.job_id AS INTEGER) DESC LIMIT ?',
    chainId, boardId, limit,
  )
}

export interface DripRow {
  board_id: string
  address: string
  token: string
  status: string
  tx_hash: string | null
  created_at: number
}

export async function dripState(sql: AsyncSql, boardId: string, address: string): Promise<DripRow | undefined> {
  const [row] = await sql.all<DripRow>('SELECT * FROM drips WHERE board_id = ? AND address = ?', boardId, address.toLowerCase())
  return row
}

/**
 * Reserves the one drip an address gets on a board (R114-07: the row exists before any money moves). Returns true
 * when this call owns the reservation (its random token won), false when someone else already holds or made it.
 */
export async function dripReserve(sql: AsyncSql, boardId: string, address: string, token: string, now: number): Promise<boolean> {
  await sql.batch([stmt("INSERT OR IGNORE INTO drips (board_id, address, token, status, tx_hash, created_at) VALUES (?, ?, ?, 'reserved', NULL, ?)", boardId, address.toLowerCase(), token, now)])
  const row = await dripState(sql, boardId, address)
  return row !== undefined && row.token === token
}

export async function dripFinish(sql: AsyncSql, boardId: string, address: string, status: 'sent' | 'skipped' | 'failed', txHash: string | null): Promise<void> {
  await sql.batch([stmt('UPDATE drips SET status = ?, tx_hash = ? WHERE board_id = ? AND address = ?', status, txHash, boardId, address.toLowerCase())])
}
