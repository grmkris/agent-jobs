/**
 * What Explore reads from the indexer's D1: chain facts only. Off-chain progress (titles, candidates, Jev) comes
 * from the board. An evidence statement is labelled "matches the awarded on-chain deliverable" only when it names
 * the recorded `JobSubmitted` deliverable and is unexpired now (R114-06); otherwise it is not an on-chain match.
 */
import type { AsyncSql } from './store.ts'
import { allStacks, type Deployment } from '@agent-jobs/sdk'

/** Stack names can be reused. Only the original Published contract identifies a job's Holding. */
export function configuredJobs(deployment: Deployment, alias: 'jobs' | 'j' = 'jobs') {
  const holdings = allStacks(deployment).map(([, stack]) => stack.holding.toLowerCase())
  return {
    clause: holdings.length === 0 ? '0' : `EXISTS (SELECT 1 FROM events published
      WHERE published.chain_id=${alias}.chain_id AND published.job_id=${alias}.job_id
        AND published.name='Published' AND lower(published.contract) IN (${holdings.map(() => '?').join(',')}))`,
    params: holdings,
  }
}

export async function jobAvailability(sql: AsyncSql, deployment: Deployment, jobId: string) {
  const rows = await sql.all<{ holding: string }>(
    "SELECT DISTINCT lower(contract) AS holding FROM events WHERE chain_id=? AND job_id=? AND name='Published'",
    deployment.chainId, jobId,
  )
  if (rows.length !== 1) return { status: 'unavailable' as const, actionable: false, holding: null }
  const holding = rows[0]!.holding
  const configured = allStacks(deployment).some(([, stack]) => stack.holding.toLowerCase() === holding)
  return { status: configured ? 'active' as const : 'archived' as const, actionable: configured, holding }
}

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
  kind: 'legacy' | 'hireling-v1' | null
  arbitrator: string | null
  expired_at: number | null
  review_window: number | null
  dispute_window: number | null
  arbitration_window: number | null
  fee_bps: number | null
  fee: string | null
  net: string | null
  bonus: string | null
  outcome: string | null
  settlement_outcome: string | null
  charged_fee: string | null
  bonus_fee: string | null
  payout_deferred: number | null
  refund_deferred: number | null
  refunded_to_holding: number | null
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
    topUps: await sql.all('SELECT contributor, amount, refunded, block, tx_hash FROM top_ups WHERE chain_id = ? AND job_id = ? ORDER BY block, log_index', chainId, jobId),
    fees: await sql.all('SELECT token, worker, creator, amount, bonus_part, block, tx_hash FROM fee_charges WHERE chain_id = ? AND job_id = ? ORDER BY block, log_index', chainId, jobId),
    // Historical failed pushes. Current withdrawable balances are pooled by token/account and read on-chain.
    payoutsOwed: await sql.all('SELECT recipient, token, amount, block, tx_hash FROM payout_owed WHERE chain_id = ? AND job_id = ? ORDER BY block, log_index', chainId, jobId),
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
  type Row = { name: string; block: number; log_index: number; tx_hash: string; args_json: string; timestamp: number | null }
  const rows = await sql
    .all<Row>(
      `SELECT e.name, e.block, e.log_index, e.tx_hash, e.args_json, b.timestamp FROM events e
       LEFT JOIN block_times b ON b.chain_id = e.chain_id AND b.block = e.block
       WHERE e.chain_id = ? AND e.job_id = ? ORDER BY e.block, e.log_index`,
      chainId,
      jobId,
    )
    // Before the indexer's first run after a deploy has created block_times, the times read as unknown.
    .catch(() =>
      sql.all<Row>('SELECT name, block, log_index, tx_hash, args_json, NULL AS timestamp FROM events WHERE chain_id = ? AND job_id = ? ORDER BY block, log_index', chainId, jobId),
    )
  return rows.map((r) => ({ name: r.name, block: r.block, logIndex: r.log_index, txHash: r.tx_hash, args: JSON.parse(r.args_json) as Record<string, unknown>, at: r.timestamp }))
}

/** Job-less chain facts, such as stake reservations, epoch roots and claims, in chain order. */
export async function protocolEvents(sql: AsyncSql, chainId: number, opts: { contract?: string; fromBlock?: number; toBlock?: number; limit?: number } = {}): Promise<TimelineEvent[]> {
  const rows = await sql.all<{ name: string; block: number; log_index: number; tx_hash: string; args_json: string; timestamp: number | null }>(
    `SELECT e.name, e.block, e.log_index, e.tx_hash, e.args_json, b.timestamp FROM protocol_events e
     LEFT JOIN block_times b ON b.chain_id = e.chain_id AND b.block = e.block
     WHERE e.chain_id = ? AND e.block >= ? AND e.block < ? ${opts.contract === undefined ? '' : 'AND e.contract = ?'}
     ORDER BY e.block, e.log_index LIMIT ?`,
    chainId, opts.fromBlock ?? 0, opts.toBlock ?? Number.MAX_SAFE_INTEGER,
    ...(opts.contract === undefined ? [] : [opts.contract.toLowerCase()]), Math.max(1, Math.min(opts.limit ?? 200, 10_000)),
  )
  return rows.map((r) => ({ name: r.name, block: r.block, logIndex: r.log_index, txHash: r.tx_hash, args: JSON.parse(r.args_json) as Record<string, unknown>, at: r.timestamp }))
}

// ---------------------------------------------------------------------------------------------------------------
// Agents: what any operator or creator can read about an ERC-8004 agent's work here, from chain facts only.
// Amounts are base-unit strings summed with BigInt (SQLite integers overflow above 9.2e18). Lost contest entries
// are off-chain and never counted.
// ---------------------------------------------------------------------------------------------------------------

const IN_PROGRESS = ['active', 'awarded', 'submitted', 'rejected-pending', 'disputed']
// A deferred payout may leave the core Rejected while the evaluator's paid-work decision still stands (M2).
const WORKER_OUTCOMES = "('Accepted', 'Silence', 'RuledForWorker')"

export interface AgentSummary {
  agentId: string
  jobs: number
  completed: number
  inProgress: number
  /** Rejected or expired after the agent took the job. */
  lost: number
  /** Base units per reward token, paid to the agent's wallet. */
  earned: Record<string, string>
  /** ERC-8004 feedback this protocol's evaluators wrote, by tag (`completed`, `rejected-quality`, …). */
  feedback: Record<string, number>
  lastBlock: number
}

function sumBy(rows: ReadonlyArray<{ key: string; token: string | null; amount: string }>): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, bigint>>()
  for (const r of rows) {
    if (r.token === null) continue
    const per = out.get(r.key) ?? {}
    per[r.token] = (per[r.token] ?? 0n) + BigInt(r.amount)
    out.set(r.key, per)
  }
  return new Map([...out].map(([k, per]) => [k, Object.fromEntries(Object.entries(per).map(([t, v]) => [t, v.toString()]))]))
}

function sumAccounting(rows: ReadonlyArray<{ token: string | null; reward: string; bonus: string; fee: string }>): Record<string, { gross: string; fee: string; net: string }> {
  const totals = new Map<string, { gross: bigint; fee: bigint; net: bigint }>()
  for (const row of rows) {
    if (row.token === null) continue
    const total = totals.get(row.token) ?? { gross: 0n, fee: 0n, net: 0n }
    const gross = BigInt(row.reward) + BigInt(row.bonus)
    const fee = BigInt(row.fee)
    total.gross += gross
    total.fee += fee
    total.net += gross - fee
    totals.set(row.token, total)
  }
  return Object.fromEntries([...totals].map(([token, total]) => [token, {
    gross: total.gross.toString(),
    fee: total.fee.toString(),
    net: total.net.toString(),
  }]))
}

async function summaries(sql: AsyncSql, chainId: number, agentIds: readonly string[] | null, limit: number): Promise<AgentSummary[]> {
  const only = agentIds === null ? '' : `AND agent_id IN (${agentIds.map(() => '?').join(', ')})`
  const ids = agentIds ?? []
  const counts = await sql.all<{ agent_id: string; jobs: number; completed: number; in_progress: number; lost: number; last_block: number }>(
    `SELECT agent_id, COUNT(*) AS jobs,
       SUM(CASE WHEN status = 'completed' OR outcome IN ${WORKER_OUTCOMES} THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status IN (${IN_PROGRESS.map(() => '?').join(', ')}) AND COALESCE(outcome, 'None') = 'None' THEN 1 ELSE 0 END) AS in_progress,
       SUM(CASE WHEN status IN ('rejected', 'expired') AND COALESCE(outcome, 'None') NOT IN ${WORKER_OUTCOMES} THEN 1 ELSE 0 END) AS lost,
       MAX(updated_block) AS last_block
     FROM jobs WHERE chain_id = ? AND agent_id IS NOT NULL AND agent_id <> '0' ${only}
     GROUP BY agent_id ORDER BY completed DESC, last_block DESC LIMIT ?`,
    ...IN_PROGRESS, chainId, ...ids, limit,
  )
  if (counts.length === 0) return []
  const listed = counts.map((c) => c.agent_id)
  const marks = listed.map(() => '?').join(', ')
  const paid = await sql.all<{ key: string; token: string | null; amount: string }>(
    `SELECT j.agent_id AS key, j.token, r.amount FROM reward_outcomes r
     JOIN jobs j ON j.chain_id = r.chain_id AND j.job_id = r.job_id
     WHERE r.chain_id = ? AND r.kind = 'paid' AND lower(r.recipient) = lower(j.worker) AND j.agent_id IN (${marks})`,
    chainId, ...listed,
  )
  const earned = sumBy(paid)
  const tags = await sql.all<{ agent_id: string; tag: string | null; n: number }>(
    `SELECT agent_id, tag, COUNT(*) AS n FROM feedback WHERE chain_id = ? AND recorded = 1 AND agent_id IN (${marks}) GROUP BY agent_id, tag`,
    chainId, ...listed,
  )
  return counts.map((c) => ({
    agentId: c.agent_id,
    jobs: c.jobs,
    completed: c.completed,
    inProgress: c.in_progress,
    lost: c.lost,
    earned: earned.get(c.agent_id) ?? {},
    feedback: Object.fromEntries(tags.filter((t) => t.agent_id === c.agent_id && t.tag !== null).map((t) => [t.tag as string, t.n])),
    lastBlock: c.last_block,
  }))
}

/** Every agent that has taken a job here, most completed first. */
export async function listAgents(sql: AsyncSql, chainId: number, limit = 200): Promise<AgentSummary[]> {
  return summaries(sql, chainId, null, limit)
}

/** The agents a wallet has worked as (ERC-8004 has no reverse lookup; only agents with a job are found). */
export async function agentsOfWallet(sql: AsyncSql, chainId: number, wallet: string): Promise<string[]> {
  const rows = await sql.all<{ agent_id: string }>(
    "SELECT DISTINCT agent_id FROM jobs WHERE chain_id = ? AND lower(worker) = lower(?) AND agent_id IS NOT NULL AND agent_id <> '0' ORDER BY agent_id",
    chainId, wallet,
  )
  return rows.map((r) => r.agent_id)
}

/** One agent's record: its summary, the wallets it worked from, and each job it took with the job's outcome rows. */
export async function agentDetail(sql: AsyncSql, chainId: number, agentId: string) {
  const [summary] = await summaries(sql, chainId, [agentId], 1)
  if (summary === undefined) return undefined
  const jobs = await sql.all<JobRow & { submitted_block: number | null }>(
    `SELECT j.*, s.block AS submitted_block FROM jobs j LEFT JOIN submissions s ON s.chain_id = j.chain_id AND s.job_id = j.job_id
     WHERE j.chain_id = ? AND j.agent_id = ? ORDER BY CAST(j.job_id AS INTEGER) DESC`,
    chainId, agentId,
  )
  const bonds = await sql.all<{ outcome: string; n: number }>(
    `SELECT b.outcome, COUNT(*) AS n FROM bond_outcomes b JOIN jobs j ON j.chain_id = b.chain_id AND j.job_id = b.job_id
     WHERE b.chain_id = ? AND j.agent_id = ? AND b.side = 'worker' GROUP BY b.outcome`,
    chainId, agentId,
  )
  const feedback = await sql.all<{ job_id: string; value: string | null; tag: string | null; recorded: number; tx_hash: string }>(
    'SELECT job_id, value, tag, recorded, tx_hash FROM feedback WHERE chain_id = ? AND agent_id = ? ORDER BY CAST(job_id AS INTEGER) DESC',
    chainId, agentId,
  )
  return {
    agent: summary,
    wallets: [...new Set(jobs.map((j) => j.worker).filter((w): w is string => w !== null))],
    bonds: Object.fromEntries(bonds.map((b) => [b.outcome, b.n])) as Record<string, number>,
    jobs,
    feedback,
  }
}

/** The network's headline numbers for a first visit: jobs, paid jobs, agents, what is paid out and what is held now. */
export async function networkStats(sql: AsyncSql, chainId: number) {
  const [counts] = await sql.all<{ jobs: number; completed: number; agents: number }>(
    `SELECT COUNT(*) AS jobs, SUM(CASE WHEN status = 'completed' OR outcome IN ${WORKER_OUTCOMES} THEN 1 ELSE 0 END) AS completed,
       COUNT(DISTINCT CASE WHEN agent_id IS NOT NULL AND agent_id <> '0' THEN agent_id END) AS agents
     FROM jobs WHERE chain_id = ?`,
    chainId,
  )
  const paid = await sql.all<{ key: string; token: string | null; amount: string }>(
    `SELECT 'all' AS key, j.token, r.amount FROM reward_outcomes r JOIN jobs j ON j.chain_id = r.chain_id AND j.job_id = r.job_id
     WHERE r.chain_id = ? AND r.kind = 'paid'`,
    chainId,
  )
  const accounting = await sql.all<{ token: string | null; reward: string; bonus: string; fee: string }>(
    `SELECT token, reward, COALESCE(bonus, '0') AS bonus, COALESCE(charged_fee, '0') AS fee
     FROM jobs WHERE chain_id = ? AND reward IS NOT NULL
       AND ((kind = 'hireling-v1' AND settlement_outcome = 'Paid') OR (kind = 'legacy' AND status = 'completed'))`,
    chainId,
  )
  const workerTransfers = await sql.all<{ key: string; token: string | null; amount: string }>(
    `SELECT 'all' AS key, j.token, r.amount FROM reward_outcomes r JOIN jobs j ON j.chain_id = r.chain_id AND j.job_id = r.job_id
     WHERE r.chain_id = ? AND r.kind = 'paid' AND lower(r.recipient) = lower(j.worker)`,
    chainId,
  )
  const workerPaid = sumBy(workerTransfers).get('all') ?? {}
  const activity = await sql.all<{ demo: number; total: number }>(
    `SELECT SUM(CASE WHEN stack LIKE 'demo%' THEN 1 ELSE 0 END) AS demo, COUNT(*) AS total FROM jobs WHERE chain_id = ?`,
    chainId,
  )
  const demo = activity[0]?.demo ?? 0
  const total = activity[0]?.total ?? 0
  // Held in escrow now: published jobs whose reward has not left Holding or the core.
  const held = await sql.all<{ key: string; token: string | null; amount: string }>(
    `SELECT 'all' AS key, token, reward AS amount FROM jobs WHERE chain_id = ? AND reward IS NOT NULL AND status IN ('open', ${IN_PROGRESS.map(() => '?').join(', ')})`,
    chainId, ...IN_PROGRESS,
  )
  return {
    jobs: counts?.jobs ?? 0,
    completed: counts?.completed ?? 0,
    agents: counts?.agents ?? 0,
    paidOut: sumBy(paid).get('all') ?? {},
    inEscrow: sumBy(held).get('all') ?? {},
    activity: { demo, unclassified: Math.max(0, total - demo), independent: null },
    accounting: Object.fromEntries(Object.entries(sumAccounting(accounting)).map(([token, row]) => [token, {
      ...row,
      paid: workerPaid[token] ?? '0',
    }])),
  }
}
