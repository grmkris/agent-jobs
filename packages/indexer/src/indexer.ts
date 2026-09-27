/**
 * One indexing run (spec §5 `apps/indexer`, plan S4): under a lease, read finalized logs of the core, every Holding
 * and every evaluator from the checkpoint, decode them, and commit in ONE batch per page: the new events, every
 * affected job re-folded from all its events, and the advanced checkpoint. A crash before the batch changes
 * nothing; a crash after it is a completed page. A replayed page inserts no event twice and folds to the same rows.
 *
 * Only finalized blocks are indexed (Monad answers the `finalized` tag), so a reorg should never reach D1; the
 * guard still compares the hash of the last indexed block with the chain and rewinds if they differ.
 */
import { type Contracts, type IndexedEvent, decode } from './events.ts'
import { byChainOrder, foldJob } from './fold.ts'
import type { ChainHead, LogSource } from './source.ts'
import { type AsyncSql, type Statement, DERIVED_TABLES, stmt } from './store.ts'

export interface IndexerConfig {
  readonly contracts: Contracts
  readonly deployBlock: number
  readonly source: LogSource
  readonly head: ChainHead
  readonly runner: string
  readonly now?: () => number
  /** Pages per run (each page is one atomic batch). */
  readonly maxPages?: number
  readonly leaseSeconds?: number
  /** How far to rewind when the last indexed block's hash no longer matches the chain. */
  readonly rewindBlocks?: number
}

export interface RunResult {
  readonly lease: boolean
  readonly pages: number
  readonly events: number
  readonly jobs: number
  readonly nextBlock: number | null
  readonly rewound: boolean
}

interface EventRow {
  contract: string
  block: number
  log_index: number
  tx_hash: string
  job_id: string
  name: string
  args_json: string
}

const toEvent = (chainId: number, r: EventRow): IndexedEvent => ({
  chainId,
  contract: r.contract,
  block: r.block,
  logIndex: r.log_index,
  txHash: r.tx_hash,
  jobId: r.job_id,
  name: r.name,
  args: JSON.parse(r.args_json) as IndexedEvent['args'],
})

async function takeLease(sql: AsyncSql, cfg: IndexerConfig, now: number): Promise<boolean> {
  const id = `indexer:${cfg.contracts.chainId}`
  await sql.batch([
    stmt(
      `INSERT INTO lease (id, holder, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
       WHERE lease.expires_at <= ? OR lease.holder = excluded.holder`,
      id, cfg.runner, now + (cfg.leaseSeconds ?? 120), now,
    ),
  ])
  const [row] = await sql.all<{ holder: string }>('SELECT holder FROM lease WHERE id = ?', id)
  return row?.holder === cfg.runner
}

export async function releaseLease(sql: AsyncSql, cfg: IndexerConfig): Promise<void> {
  await sql.batch([stmt('DELETE FROM lease WHERE id = ? AND holder = ?', `indexer:${cfg.contracts.chainId}`, cfg.runner)])
}

const eventKey = (e: IndexedEvent) => `${e.contract}:${e.block}:${e.logIndex}`

/** Re-folds `jobIds` from their stored events plus `fresh` (deduplicated by event identity). */
async function refold(sql: AsyncSql, cfg: IndexerConfig, jobIds: Iterable<string>, fresh: readonly IndexedEvent[]): Promise<Statement[]> {
  const chainId = cfg.contracts.chainId
  const out: Statement[] = []
  for (const jobId of jobIds) {
    const stored = (await sql.all<EventRow>('SELECT * FROM events WHERE chain_id = ? AND job_id = ?', chainId, jobId)).map((r) => toEvent(chainId, r))
    const all = new Map(stored.map((e) => [eventKey(e), e]))
    for (const e of fresh) if (e.jobId === jobId) all.set(eventKey(e), e)
    out.push(...foldJob(cfg.contracts, chainId, jobId, [...all.values()].toSorted(byChainOrder)))
  }
  return out
}

/** Drops everything from `block` on and re-folds the jobs it touched; the checkpoint moves back to `block`. */
async function rewindTo(sql: AsyncSql, cfg: IndexerConfig, block: number, now: number): Promise<void> {
  const chainId = cfg.contracts.chainId
  const touched = await sql.all<{ job_id: string }>('SELECT DISTINCT job_id FROM events WHERE chain_id = ? AND block >= ?', chainId, block)
  const deleteLater = stmt('DELETE FROM events WHERE chain_id = ? AND block >= ?', chainId, block)
  // Fold from the events that remain below `block`.
  const statements: Statement[] = []
  for (const { job_id } of touched) {
    const kept = (await sql.all<EventRow>('SELECT * FROM events WHERE chain_id = ? AND job_id = ? AND block < ?', chainId, job_id, block)).map((r) => toEvent(chainId, r))
    statements.push(...foldJob(cfg.contracts, chainId, job_id, kept))
  }
  await sql.batch([
    deleteLater,
    ...statements,
    stmt('INSERT OR REPLACE INTO checkpoint (chain_id, next_block, block_hash, updated_at) VALUES (?, ?, NULL, ?)', chainId, block, now),
  ])
}

export async function runOnce(sql: AsyncSql, cfg: IndexerConfig): Promise<RunResult> {
  const now = (cfg.now ?? (() => Math.floor(Date.now() / 1000)))()
  const chainId = cfg.contracts.chainId
  if (!(await takeLease(sql, cfg, now))) return { lease: false, pages: 0, events: 0, jobs: 0, nextBlock: null, rewound: false }
  const addresses = [...cfg.contracts.roles.keys()]
  let [cp] = await sql.all<{ next_block: number; block_hash: string | null }>('SELECT next_block, block_hash FROM checkpoint WHERE chain_id = ?', chainId)
  let rewound = false
  if (cp !== undefined && cp.block_hash !== null && cp.next_block > cfg.deployBlock) {
    const onChain = await cfg.head.blockHash(cp.next_block - 1)
    if (onChain !== null && onChain.toLowerCase() !== cp.block_hash.toLowerCase()) {
      await rewindTo(sql, cfg, Math.max(cfg.deployBlock, cp.next_block - (cfg.rewindBlocks ?? 100)), now)
      rewound = true
      ;[cp] = await sql.all<{ next_block: number; block_hash: string | null }>('SELECT next_block, block_hash FROM checkpoint WHERE chain_id = ?', chainId)
    }
  }
  let next = cp?.next_block ?? cfg.deployBlock
  const finalized = await cfg.head.finalizedBlock()
  let pages = 0
  let events = 0
  const jobs = new Set<string>()
  while (pages < (cfg.maxPages ?? 5) && next <= finalized) {
    const page = await cfg.source.logs({ fromBlock: next, toBlock: finalized + 1, addresses })
    const fresh = page.logs.map((l) => decode(cfg.contracts, l)).filter((e): e is IndexedEvent => e !== undefined)
    const pageJobs = new Set(fresh.map((e) => e.jobId))
    const upTo = Math.min(Math.max(page.nextBlock, next), finalized + 1)
    const hash = await cfg.head.blockHash(upTo - 1)
    await sql.batch([
      ...fresh.map((e) =>
        stmt('INSERT OR IGNORE INTO events (chain_id, contract, block, log_index, tx_hash, job_id, name, args_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          chainId, e.contract, e.block, e.logIndex, e.txHash, e.jobId, e.name, JSON.stringify(e.args))),
      ...(await refold(sql, cfg, pageJobs, fresh)),
      stmt('INSERT OR REPLACE INTO checkpoint (chain_id, next_block, block_hash, updated_at) VALUES (?, ?, ?, ?)', chainId, upTo, hash, now),
    ])
    pages++
    events += fresh.length
    for (const j of pageJobs) jobs.add(j)
    if (upTo === next) break // no progress possible now
    next = upTo
  }
  return { lease: true, pages, events, jobs: jobs.size, nextBlock: next, rewound }
}

/** Full rebuild: chain facts only, from the deploy block (board records are not the indexer's). */
export async function resetIndex(sql: AsyncSql, cfg: IndexerConfig): Promise<void> {
  await sql.batch([
    ...DERIVED_TABLES.map((t) => stmt(`DELETE FROM ${t} WHERE chain_id = ?`, cfg.contracts.chainId)),
    stmt('DELETE FROM events WHERE chain_id = ?', cfg.contracts.chainId),
    stmt('DELETE FROM checkpoint WHERE chain_id = ?', cfg.contracts.chainId),
  ])
}
