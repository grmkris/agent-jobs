/**
 * The board registry (ADR-0008): which tenant boards exist and what they offer, which frozen offers belong to which
 * board (`terms_hash` = the listing's `policyHash`, so chain jobs are attributed without a board field on-chain), and
 * the once-per-address MON drips. Lives in the API's D1 next to the indexer's chain facts; the API Worker is the only
 * writer of these tables, the indexer of its own.
 */
import { BoardError, type TenantConfig } from '@sidequest/board'
import {
  type AsyncSql,
  type JobRow,
  configuredJobs,
  foreignOffer,
  foreignOffersForJobs,
  offerHashForJob,
  type ForeignOffer,
  OFFER_HASH_SQL,
  jobAvailability,
  jobDetail,
  JOB_STEP_EVENTS,
  type JobStep,
  decodeJobStepCursor,
  encodeJobStepCursor,
  jobStepOfEvent,
  stmt,
} from '@sidequest/indexer'
import type { Deployment } from '@sidequest/sdk'

const REGISTRY_SCHEMA: readonly string[] = [
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

const parse = (r: BoardRow): StoredBoard => ({
  config: JSON.parse(r.config_json) as TenantConfig,
  webhookSecret: r.webhook_secret,
})

export async function getBoard(sql: AsyncSql, id: string): Promise<StoredBoard | undefined> {
  const [row] = await sql.all<BoardRow>('SELECT * FROM boards WHERE id = ?', id)
  return row === undefined ? undefined : parse(row)
}

export async function listBoards(sql: AsyncSql): Promise<TenantConfig[]> {
  return (await sql.all<BoardRow>('SELECT * FROM boards ORDER BY created_at')).map((r) => parse(r).config)
}

/** Inserts a board; false when the slug is taken. */
export async function createBoard(
  sql: AsyncSql,
  config: TenantConfig,
  webhookSecret: string | null,
  now: number,
): Promise<boolean> {
  if ((await getBoard(sql, config.id)) !== undefined) return false
  await sql.batch([
    stmt(
      'INSERT INTO boards (id, name, owner, config_json, webhook_secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      config.id,
      config.name,
      config.owner ?? '',
      JSON.stringify(config),
      webhookSecret,
      now,
      now,
    ),
  ])
  return true
}

export async function updateBoard(
  sql: AsyncSql,
  config: TenantConfig,
  webhookSecret: string | null | undefined,
  now: number,
): Promise<void> {
  await sql.batch([
    webhookSecret === undefined
      ? stmt(
          'UPDATE boards SET name = ?, config_json = ?, updated_at = ? WHERE id = ?',
          config.name,
          JSON.stringify(config),
          now,
          config.id,
        )
      : stmt(
          'UPDATE boards SET name = ?, config_json = ?, webhook_secret = ?, updated_at = ? WHERE id = ?',
          config.name,
          JSON.stringify(config),
          webhookSecret,
          now,
          config.id,
        ),
  ])
}

/** Attributes a frozen offer (its terms hash is the listing's policyHash) to the board it was created on. */
export async function recordOffer(
  sql: AsyncSql,
  input: { boardId: string; termsHash: string; taskId: string; now: number },
): Promise<void> {
  await sql.batch([
    stmt(
      'INSERT OR IGNORE INTO board_offers (terms_hash, board_id, task_id, created_at) VALUES (?, ?, ?, ?)',
      input.termsHash.toLowerCase(),
      input.boardId,
      input.taskId,
      input.now,
    ),
  ])
}

export async function boardOfTerms(
  sql: AsyncSql,
  termsHash: string,
): Promise<{ boardId: string; taskId: string } | undefined> {
  const [row] = await sql.all<{ board_id: string; task_id: string }>(
    'SELECT board_id, task_id FROM board_offers WHERE terms_hash = ?',
    termsHash.toLowerCase(),
  )
  return row === undefined ? undefined : { boardId: row.board_id, taskId: row.task_id }
}

export type JobWithBoard = JobRow & { board_id: string | null; foreign_offer?: ForeignOffer | undefined }

/** Chain jobs with the board each offer belongs to (null: published outside any hosted board). */
/** The boards that froze these terms (a job's policy hash), by lowercase hash; hashes no board froze are absent. */
export async function boardsOfTerms(
  sql: AsyncSql,
  termsHashes: ReadonlyArray<string | null>,
): Promise<Map<string, string>> {
  const hashes = [...new Set(termsHashes.filter((h): h is string => h !== null).map((h) => h.toLowerCase()))]
  const out = new Map<string, string>()
  // D1 binds at most 100 parameters per query.
  for (let i = 0; i < hashes.length; i += 90) {
    const page = hashes.slice(i, i + 90)
    const rows = await sql.all<{ terms_hash: string; board_id: string }>(
      `SELECT terms_hash, board_id FROM board_offers WHERE terms_hash IN (${page.map(() => '?').join(', ')})`,
      ...page,
    )
    for (const row of rows) out.set(row.terms_hash, row.board_id)
  }
  return out
}

/** A page of jobs below `before` (a job id), newest first: what `/data/jobs?cursor=` continues from. */
const beforeClause = (before: string | undefined) => (before === undefined ? '' : 'AND CAST(j.job_id AS INTEGER) < ?')
const beforeParams = (before: string | undefined) => (before === undefined ? [] : [Number(before)])

export async function jobsWithBoards(
  sql: AsyncSql,
  deployment: Deployment,
  limit = 200,
  before?: string,
): Promise<JobWithBoard[]> {
  const configured = configuredJobs(deployment, 'j')
  const rows = await sql.all<JobWithBoard>(
    `SELECT j.*, o.board_id FROM jobs j LEFT JOIN board_offers o ON lower(${OFFER_HASH_SQL}) = o.terms_hash WHERE j.chain_id = ? AND ${configured.clause} ${beforeClause(before)} ORDER BY CAST(j.job_id AS INTEGER) DESC LIMIT ?`,
    deployment.chainId,
    ...configured.params,
    ...beforeParams(before),
    limit,
  )
  const offers = await foreignOffersForJobs(
    sql,
    deployment.chainId,
    rows.map((row) => row.job_id),
  )
  return rows.map((row) => ({ ...row, foreign_offer: offers.get(row.job_id) }))
}

export async function jobsOfBoard(
  sql: AsyncSql,
  deployment: Deployment,
  boardId: string,
  limit = 200,
  before?: string,
): Promise<JobWithBoard[]> {
  const configured = configuredJobs(deployment, 'j')
  return sql.all<JobWithBoard>(
    `SELECT j.*, o.board_id FROM jobs j JOIN board_offers o ON lower(${OFFER_HASH_SQL}) = o.terms_hash WHERE j.chain_id = ? AND o.board_id = ? AND ${configured.clause} ${beforeClause(before)} ORDER BY CAST(j.job_id AS INTEGER) DESC LIMIT ?`,
    deployment.chainId,
    boardId,
    ...configured.params,
    ...beforeParams(before),
    limit,
  )
}

/**
 * Whether the chain recorded `hash` as the current delivery of the job made from this board's task: the preview route
 * reads nothing for a hash the chain never saw.
 */
export async function submittedDeliverable(
  sql: AsyncSql,
  deployment: Deployment,
  q: { boardId: string; taskId: string; hash: string },
): Promise<boolean> {
  const configured = configuredJobs(deployment, 'j')
  const rows = await sql.all<{ hit: number }>(
    `SELECT 1 AS hit FROM jobs j JOIN board_offers o ON lower(${OFFER_HASH_SQL}) = o.terms_hash WHERE j.chain_id = ? AND o.board_id = ? AND o.task_id = ? AND lower(j.deliverable) = ? AND ${configured.clause} LIMIT 1`,
    deployment.chainId,
    q.boardId,
    q.taskId,
    q.hash.toLowerCase(),
    ...configured.params,
  )
  return rows.length > 0
}

export interface RecentJobStep {
  readonly jobId: string
  readonly step: JobStep
  readonly at: number | null
  readonly txHash: string
  readonly boardId: string | null
  readonly agentId: string | null
  readonly token?: string
  readonly amount?: string
}

interface JobStepRow {
  job_id: string
  name: string
  block: number
  log_index: number
  tx_hash: string
  timestamp: number | null
  board_id: string | null
  agent_id: string | null
  token: string | null
  reward: string | null
  net: string | null
  paid_json: string | null
}

function stepAmount(row: JobStepRow, step: JobStep): string | null {
  if (step === 'posted') return row.reward
  if (step !== 'completed') return null
  // SAFETY: json_group_array packs reward_outcomes.amount TEXT values written by the event fold.
  const paid = row.paid_json === null ? [] : (JSON.parse(row.paid_json) as string[])
  // Sum recorded worker transfers as decimal strings, including a paid bonus; core payments to Holding and
  // refunds are excluded. A completed job's net is the known core payment when transfer rows are unavailable.
  return paid.length === 0 ? row.net : paid.reduce((total, value) => total + BigInt(value), 0n).toString()
}

function recentStep(row: JobStepRow): RecentJobStep {
  const step = jobStepOfEvent(row.name)!
  const amount = stepAmount(row, step)
  return {
    jobId: row.job_id,
    step,
    at: row.timestamp,
    txHash: row.tx_hash,
    boardId: row.board_id,
    // jobs has only the worker's agent_id; it cannot identify a publication's creator or a ruling's arbitrator.
    agentId: ['hired', 'delivered', 'completed'].includes(step) ? row.agent_id : null,
    ...(amount === null || row.token === null ? {} : { token: row.token, amount }),
  }
}

interface StepFilterOptions {
  boardId?: string
  cursor?: string
  wallet?: string
}

/**
 * The activity read's optional narrowing, checked and turned into SQL with its parameters in placeholder order: a
 * board, a wallet (the jobs it posted, approves or worked) and the page cursor.
 */
function stepFilters(opts: StepFilterOptions): { sql: string; params: (string | number)[] } {
  if (opts.boardId !== undefined && !/^[a-z0-9-]{3,32}$/.test(opts.boardId))
    throw new BoardError('invalid', 'board must be a board slug (3–32 lowercase letters, digits or hyphens)')
  if (opts.wallet !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(opts.wallet))
    throw new BoardError('invalid', 'wallet must be a 0x address')
  const cursor = opts.cursor === undefined ? undefined : decodeJobStepCursor(opts.cursor)
  if (opts.cursor !== undefined && cursor === undefined) throw new BoardError('invalid', 'invalid activity cursor')
  const parts: { sql: string; params: (string | number)[] }[] = []
  if (opts.boardId !== undefined) parts.push({ sql: 'AND o.board_id = ?', params: [opts.boardId] })
  if (opts.wallet !== undefined) {
    const wallet = opts.wallet.toLowerCase()
    parts.push({
      sql: 'AND (lower(j.creator) = ? OR lower(j.approver) = ? OR lower(j.worker) = ?)',
      params: [wallet, wallet, wallet],
    })
  }
  if (cursor !== undefined)
    parts.push({
      sql: 'AND (e.block < ? OR (e.block = ? AND e.log_index < ?))',
      params: [cursor.block, cursor.block, cursor.logIndex],
    })
  return { sql: parts.map((p) => p.sql).join('\n      '), params: parts.flatMap((p) => p.params) }
}

/** Anonymous chain activity, attributed to boards without exposing event arguments or private quote terms. */
export async function recentJobSteps(
  sql: AsyncSql,
  deployment: Deployment,
  opts: StepFilterOptions & { limit?: number } = {},
): Promise<{ steps: RecentJobStep[]; nextCursor: string | null }> {
  const limit = opts.limit ?? 20
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new BoardError('invalid', 'limit must be an integer between 1 and 50')
  const filters = stepFilters(opts)
  const configured = configuredJobs(deployment, 'j')
  const names = Object.keys(JOB_STEP_EVENTS)
  const params = [deployment.chainId, ...configured.params, ...names, ...filters.params, limit + 1]
  const query = (withTimes: boolean) => `SELECT e.job_id, e.name, e.block, e.log_index, e.tx_hash,
    ${withTimes ? 'b.timestamp' : 'NULL AS timestamp'}, o.board_id, j.agent_id, j.token, j.reward, j.net,
    CASE WHEN e.name = 'JobCompleted' THEN (
      SELECT json_group_array(r.amount) FROM reward_outcomes r
      WHERE r.chain_id = j.chain_id AND r.job_id = j.job_id AND r.kind = 'paid'
        AND lower(r.recipient) = lower(j.worker)
    ) END AS paid_json
    FROM events e JOIN jobs j ON j.chain_id = e.chain_id AND j.job_id = e.job_id
    LEFT JOIN board_offers o ON lower(${OFFER_HASH_SQL}) = o.terms_hash
    ${withTimes ? 'LEFT JOIN block_times b ON b.chain_id = e.chain_id AND b.block = e.block' : ''}
    WHERE e.chain_id = ? AND ${configured.clause} AND e.name IN (${names.map(() => '?').join(', ')})
      ${filters.sql}
      AND NOT (e.name = 'JobRejected' AND EXISTS (
        SELECT 1 FROM events prior WHERE prior.chain_id = e.chain_id AND prior.job_id = e.job_id
          AND (prior.name = 'Rejected' OR (prior.name = 'Cancelled' AND prior.tx_hash = e.tx_hash))
      ))
    ORDER BY e.block DESC, e.log_index DESC LIMIT ?`
  // Rejected opens the appeal window; the core's later JobRejected finalizes it. Cancellation also rejects the
  // core job. Keep the original public step, including when the two events fall on different pages.
  const rows = await sql
    .all<JobStepRow>(query(true), ...params)
    // A fresh deploy can be read before the indexer has created block_times, just like jobTimeline.
    .catch(() => sql.all<JobStepRow>(query(false), ...params))
  const page = rows.slice(0, limit)
  const steps = page.map(recentStep)
  const last = page.at(-1)
  return {
    steps,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeJobStepCursor({ block: last.block, logIndex: last.log_index })
        : null,
  }
}

/** Keep historical evidence readable, with an explicit unavailable result for a retired or unknown Holding. */
export async function jobWithBoard(sql: AsyncSql, deployment: Deployment, jobId: string, now: number) {
  const detail = await jobDetail(sql, deployment.chainId, jobId, now)
  if (detail === undefined) return { ok: false, code: 'not-found', message: 'not indexed (yet)' }
  const availability = await jobAvailability(sql, deployment, jobId)
  const hash = await offerHashForJob(sql, deployment.chainId, jobId)
  const board = hash === null ? undefined : await boardOfTerms(sql, hash)
  const foreign_offer = board === undefined && hash !== null ? await foreignOffer(sql, hash) : null
  return {
    ...detail,
    board: board ?? null,
    foreign_offer,
    availability,
    ...(availability.actionable
      ? { ok: true }
      : {
          ok: false,
          code: 'unavailable',
          message:
            availability.status === 'archived'
              ? 'archived job: its Holding is no longer configured; historical records and evidence are preserved'
              : 'job Holding is unavailable; historical records and evidence are preserved',
        }),
  }
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
  const [row] = await sql.all<DripRow>(
    'SELECT * FROM drips WHERE board_id = ? AND address = ?',
    boardId,
    address.toLowerCase(),
  )
  return row
}

/**
 * Reserves the one drip an address gets on a board (R114-07: the row exists before any money moves). Returns true
 * when this call owns the reservation (its random token won), false when someone else already holds or made it.
 */
export async function dripReserve(
  sql: AsyncSql,
  boardId: string,
  address: string,
  token: string,
  now: number,
): Promise<boolean> {
  await sql.batch([
    stmt(
      "INSERT OR IGNORE INTO drips (board_id, address, token, status, tx_hash, created_at) VALUES (?, ?, ?, 'reserved', NULL, ?)",
      boardId,
      address.toLowerCase(),
      token,
      now,
    ),
  ])
  const row = await dripState(sql, boardId, address)
  return row !== undefined && row.token === token
}

export async function dripFinish(
  sql: AsyncSql,
  boardId: string,
  address: string,
  status: 'sent' | 'skipped' | 'failed',
  txHash: string | null,
): Promise<void> {
  await sql.batch([
    stmt(
      'UPDATE drips SET status = ?, tx_hash = ? WHERE board_id = ? AND address = ?',
      status,
      txHash,
      boardId,
      address.toLowerCase(),
    ),
  ])
}
