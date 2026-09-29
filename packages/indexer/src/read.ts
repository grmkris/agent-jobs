/**
 * What Explore reads from the indexer's D1: chain facts only. Off-chain progress (titles, candidates, Jev) comes
 * from the board. An evidence statement is labelled "matches the awarded on-chain deliverable" only when it names
 * the recorded `JobSubmitted` deliverable and is unexpired now (R114-06); otherwise it is not an on-chain match.
 */
import type { AsyncSql } from './store.ts'

export interface JobRow {
  chain_id: number
  job_id: string
  stack: string | null
  mode: string | null
  creator: string | null
  approver: string | null
  token: string | null
  reward: string | null
  creator_bond: string | null
  worker_bond: string | null
  policy_hash: string | null
  delivery_deadline: number | null
  selection_deadline: number | null
  worker: string | null
  agent_id: string | null
  status: string
  deliverable: string | null
  violation: string | null
  rejection_reason_hash: string | null
  published_block: number | null
  published_tx: string | null
  updated_block: number
}

export async function listJobs(sql: AsyncSql, chainId: number, limit = 200): Promise<JobRow[]> {
  return sql.all<JobRow>('SELECT * FROM jobs WHERE chain_id = ? ORDER BY CAST(job_id AS INTEGER) DESC LIMIT ?', chainId, limit)
}

export async function jobDetail(sql: AsyncSql, chainId: number, jobId: string, now: number) {
  const [job] = await sql.all<JobRow>('SELECT * FROM jobs WHERE chain_id = ? AND job_id = ?', chainId, jobId)
  if (job === undefined) return undefined
  const [submission] = await sql.all('SELECT deliverable, provider, block, tx_hash FROM submissions WHERE chain_id = ? AND job_id = ?', chainId, jobId)
  const evidence = await sql.all<{ matches_onchain: number; valid_until: number; conclusion: number }>(
    'SELECT * FROM evidence WHERE chain_id = ? AND job_id = ? ORDER BY block, log_index',
    chainId,
    jobId,
  )
  const [ruling] = await sql.all('SELECT for_worker, slash_loser, reason_hash, block, tx_hash FROM rulings WHERE chain_id = ? AND job_id = ?', chainId, jobId)
  return {
    job,
    submission: submission ?? null,
    evidence: evidence.map((e) => ({
      ...e,
      conclusion: e.conclusion === 1 ? 'success' : 'failure',
      expired: e.valid_until <= now,
      onchainMatch: e.matches_onchain === 1 && e.valid_until > now,
    })),
    ruling: ruling ?? null,
    rewards: await sql.all('SELECT kind, recipient, amount, block, tx_hash FROM reward_outcomes WHERE chain_id = ? AND job_id = ? ORDER BY block, log_index', chainId, jobId),
    bonds: await sql.all('SELECT side, outcome, recipient, amount, block, tx_hash FROM bond_outcomes WHERE chain_id = ? AND job_id = ? ORDER BY block, log_index', chainId, jobId),
    feedback: (await sql.all('SELECT agent_id, value, tag, recorded, tx_hash FROM feedback WHERE chain_id = ? AND job_id = ?', chainId, jobId))[0] ?? null,
    timeline: await jobTimeline(sql, chainId, jobId),
  }
}

export async function indexStatus(sql: AsyncSql, chainId: number) {
  const [cp] = await sql.all<{ next_block: number; updated_at: number }>('SELECT next_block, updated_at FROM checkpoint WHERE chain_id = ?', chainId)
  return cp ?? null
}

export interface TimelineEvent {
  name: string
  block: number
  logIndex: number
  txHash: string
  args: Record<string, unknown>
  /** The block's unix time; null until the indexer has looked it up. */
  at: number | null
}

/** Every decoded event of one job in chain order, with its block's time: the steps of the job's timeline. */
export async function jobTimeline(sql: AsyncSql, chainId: number, jobId: string): Promise<TimelineEvent[]> {
  const rows = await sql.all<{ name: string; block: number; log_index: number; tx_hash: string; args_json: string; timestamp: number | null }>(
    `SELECT e.name, e.block, e.log_index, e.tx_hash, e.args_json, b.timestamp FROM events e
     LEFT JOIN block_times b ON b.chain_id = e.chain_id AND b.block = e.block
     WHERE e.chain_id = ? AND e.job_id = ? ORDER BY e.block, e.log_index`,
    chainId,
    jobId,
  )
  return rows.map((r) => ({ name: r.name, block: r.block, logIndex: r.log_index, txHash: r.tx_hash, args: JSON.parse(r.args_json) as Record<string, unknown>, at: r.timestamp }))
}
