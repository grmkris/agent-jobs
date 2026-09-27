/**
 * One job's rows, folded from its events in chain order. The fold reads nothing but the events, so the same events
 * always give the same rows: this is what makes a replayed page, a restart and a rebuild equal to live indexing.
 */
import { type Contracts, type IndexedEvent } from './events.ts'
import { type Statement, DERIVED_TABLES, stmt } from './store.ts'

const SIDES = ['creator', 'worker'] as const
const VIOLATIONS = ['None', 'Quality', 'Falsified'] as const

export function byChainOrder(a: IndexedEvent, b: IndexedEvent): number {
  return a.block - b.block || a.logIndex - b.logIndex
}

/** Replaces every derived row of one job with the fold of its events. */
export function foldJob(contracts: Contracts, chainId: number, jobId: string, events: readonly IndexedEvent[]): Statement[] {
  const ordered = events.toSorted(byChainOrder)
  const out: Statement[] = DERIVED_TABLES.map((t) => stmt(`DELETE FROM ${t} WHERE chain_id = ? AND job_id = ?`, chainId, jobId))
  if (ordered.length === 0) return out
  const job: Record<string, string | number | null> = {
    stack: null, mode: null, creator: null, approver: null, token: null, reward: null, creator_bond: null, worker_bond: null,
    policy_hash: null, delivery_deadline: null, selection_deadline: null, worker: null, agent_id: null, status: 'unknown',
    deliverable: null, violation: null, rejection_reason_hash: null, published_block: null, published_tx: null,
  }
  const evidence: IndexedEvent[] = []
  for (const e of ordered) {
    const a = e.args
    switch (e.name) {
      case 'Published':
        Object.assign(job, {
          stack: contracts.roles.get(e.contract)?.stack ?? null,
          mode: Number(a.mode) === 0 ? 'hire' : 'contest',
          creator: a.creator, approver: a.approver, token: a.token, reward: a.reward,
          creator_bond: a.creatorBond, worker_bond: a.workerBond, policy_hash: a.policyHash,
          delivery_deadline: Number(a.deliveryDeadline), selection_deadline: Number(a.selectionDeadline),
          status: 'open', published_block: e.block, published_tx: e.txHash,
        })
        break
      case 'Activated':
        Object.assign(job, { worker: a.worker, agent_id: a.agentId, status: 'active' })
        break
      case 'Awarded':
        Object.assign(job, { worker: a.worker, agent_id: a.agentId, status: 'awarded' })
        break
      case 'JobSubmitted':
        job.deliverable = a.deliverable as string
        if (job.status !== 'awarded') job.status = 'submitted'
        out.push(stmt('INSERT INTO submissions (chain_id, job_id, deliverable, provider, block, tx_hash) VALUES (?, ?, ?, ?, ?, ?)',
          chainId, jobId, a.deliverable as string, a.provider as string, e.block, e.txHash))
        break
      case 'Rejected':
        Object.assign(job, { violation: VIOLATIONS[Number(a.violation)] ?? null, rejection_reason_hash: a.reasonHash, status: 'rejected-pending' })
        break
      case 'Disputed':
        job.status = 'disputed'
        break
      case 'Ruled':
        out.push(stmt('INSERT INTO rulings (chain_id, job_id, for_worker, slash_loser, reason_hash, block, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
          chainId, jobId, a.forWorker ? 1 : 0, a.slashLoser ? 1 : 0, a.reasonHash as string, e.block, e.txHash))
        break
      case 'JobCompleted':
        job.status = 'completed'
        break
      case 'JobRejected':
        job.status = 'rejected'
        break
      case 'JobExpired':
      case 'ContestExpired':
        job.status = 'expired'
        break
      case 'Cancelled':
        job.status = 'cancelled'
        break
      case 'EvidenceAttached':
        evidence.push(e)
        break
      case 'PaymentReleased':
        out.push(stmt('INSERT INTO reward_outcomes (chain_id, job_id, block, log_index, kind, recipient, amount, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          chainId, jobId, e.block, e.logIndex, 'paid', a.recipient as string, a.amount as string, e.txHash))
        break
      case 'RewardSettled':
        out.push(stmt('INSERT INTO reward_outcomes (chain_id, job_id, block, log_index, kind, recipient, amount, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          chainId, jobId, e.block, e.logIndex, 'settled', a.to as string, a.amount as string, e.txHash))
        break
      case 'BondBurned':
      case 'BondReturned':
        out.push(stmt('INSERT INTO bond_outcomes (chain_id, job_id, block, log_index, side, outcome, recipient, amount, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          chainId, jobId, e.block, e.logIndex, SIDES[Number(a.side)] ?? String(a.side), e.name === 'BondBurned' ? 'burned' : 'returned',
          e.name === 'BondReturned' ? (a.to as string) : null, a.amount as string, e.txHash))
        break
      case 'FeedbackRecorded':
      case 'FeedbackFailed':
        out.push(stmt('INSERT OR REPLACE INTO feedback (chain_id, job_id, agent_id, value, tag, recorded, block, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          chainId, jobId, a.agentId as string, e.name === 'FeedbackRecorded' ? (a.value as string) : null,
          e.name === 'FeedbackRecorded' ? (a.tag as string) : null, e.name === 'FeedbackRecorded' ? 1 : 0, e.block, e.txHash))
        break
      default:
        break
    }
  }
  // Every statement is kept (R114-06); it "matches on-chain" only against the recorded JobSubmitted deliverable.
  for (const e of evidence) {
    const a = e.args
    out.push(stmt(
      `INSERT INTO evidence (chain_id, job_id, block, log_index, verifier, digest, submission_hash, policy_hash, tested_sha, conclusion, valid_until, matches_onchain, tx_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      chainId, jobId, e.block, e.logIndex, a.verifier as string, a.digest as string, a.submissionHash as string, a.policyHash as string,
      a.testedSha as string, Number(a.conclusion), Number(a.validUntil),
      job.deliverable !== null && String(a.submissionHash).toLowerCase() === String(job.deliverable).toLowerCase() ? 1 : 0, e.txHash,
    ))
  }
  const last = ordered[ordered.length - 1] as IndexedEvent
  const columns = [
    'stack', 'mode', 'creator', 'approver', 'token', 'reward', 'creator_bond', 'worker_bond', 'policy_hash', 'delivery_deadline',
    'selection_deadline', 'worker', 'agent_id', 'status', 'deliverable', 'violation', 'rejection_reason_hash', 'published_block', 'published_tx',
  ] as const
  out.push(stmt(
    `INSERT INTO jobs (chain_id, job_id, ${columns.join(', ')}, updated_block) VALUES (${['?', '?', ...columns.map(() => '?'), '?'].join(', ')})`,
    chainId, jobId, ...columns.map((c) => job[c] ?? null), last.block,
  ))
  return out
}
