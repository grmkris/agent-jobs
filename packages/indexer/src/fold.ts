/**
 * One job's rows, folded from its events in chain order. The fold reads nothing but the events, so the same events
 * always give the same rows: this is what makes a replayed page, a restart and a rebuild equal to live indexing.
 */
import { type Contracts, type IndexedEvent } from './events.ts'
import { type Statement, DERIVED_TABLES, stmt } from './store.ts'
import { hexToString, type Hex } from 'viem'

const SIDES = ['creator', 'worker'] as const
const VIOLATIONS = ['None', 'Quality', 'Falsified'] as const
const SETTLEMENT_OUTCOMES = ['None', 'Paid', 'Refunded'] as const
const TIMEOUT_OUTCOMES: Record<string, string> = {
  'review-window': 'Silence', 'dispute-window': 'RejectionFinal',
  'arbitration-window': 'ArbitrationTimeout', 'delivery-deadline': 'DeliveryMissed',
}

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
    policy_hash: null, manifest_hash: null, delivery_deadline: null, selection_deadline: null, worker: null, agent_id: null, status: 'unknown',
    deliverable: null, violation: null, rejection_reason_hash: null, published_block: null, published_tx: null,
    kind: null, arbitrator: null, expired_at: null, review_window: null, dispute_window: null, arbitration_window: null,
    fee_bps: null, fee: null, net: null, bonus: null, outcome: null, settlement_outcome: null,
    charged_fee: null, bonus_fee: null, payout_deferred: null, refund_deferred: null, refunded_to_holding: null,
  }
  const evidence: IndexedEvent[] = []
  for (const e of ordered) {
    const a = e.args
    switch (e.name) {
      case 'Published':
        // A retained event can outlive the active role map after a stack promotion. Its v1 publication schema is
        // self-describing, so preserve that historical interpretation during shared-core refolds while leaving the
        // retired Holding out of active discovery (configuredJobs/jobAvailability still use current addresses).
        const role = contracts.roles.get(e.contract)
        Object.assign(job, {
          stack: role?.stack ?? null,
          kind: 'sidequest-v1',
          mode: 'hire',
          creator: a.creator, approver: a.approver, token: a.token, reward: a.reward,
          creator_bond: a.creatorBond, worker_bond: a.workerBond, policy_hash: a.policyHash, manifest_hash: a.manifestHash,
          delivery_deadline: Number(a.deliveryDeadline), selection_deadline: null,
          expired_at: Number(a.expiredAt),
          status: 'open', published_block: e.block, published_tx: e.txHash,
        })
        Object.assign(job, {
          arbitrator: a.arbitrator, review_window: Number(a.reviewWindow), dispute_window: Number(a.disputeWindow),
          arbitration_window: Number(a.arbitrationWindow), bonus: '0', outcome: 'None', settlement_outcome: 'None',
          charged_fee: '0', bonus_fee: '0', payout_deferred: 0, refund_deferred: 0,
        })
        break
      case 'Activated':
        Object.assign(job, { worker: a.worker, agent_id: a.agentId, status: 'active' })
        if (a.feeBps !== undefined) Object.assign(job, { fee_bps: Number(a.feeBps), fee: a.fee, net: a.net })
        break
      case 'JobSubmitted':
        job.deliverable = a.deliverable as string
        job.status = 'submitted'
        out.push(stmt('INSERT INTO submissions (chain_id, job_id, deliverable, provider, block, tx_hash) VALUES (?, ?, ?, ?, ?, ?)',
          chainId, jobId, a.deliverable as string, a.provider as string, e.block, e.txHash))
        break
      case 'Rejected':
        Object.assign(job, { violation: VIOLATIONS[Number(a.violation)] ?? null, rejection_reason_hash: a.reasonHash, status: 'rejected-pending' })
        break
      case 'Disputed':
        job.status = 'disputed'
        break
      case 'Accepted':
        if (job.kind === 'sidequest-v1') job.outcome = 'Accepted'
        break
      case 'TimedOut':
        if (job.kind === 'sidequest-v1') job.outcome = TIMEOUT_OUTCOMES[hexToString(a.reason as Hex, { size: 32 })] ?? null
        break
      case 'Ruled':
        if (job.kind === 'sidequest-v1') job.outcome = a.forWorker ? 'RuledForWorker' : 'RuledForCreator'
        out.push(stmt('INSERT INTO rulings (chain_id, job_id, for_worker, slash_loser, reason_hash, block, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
          chainId, jobId, a.forWorker ? 1 : 0, a.slashLoser ? 1 : 0, a.reasonHash as string, e.block, e.txHash))
        break
      case 'PayoutDeferred':
        Object.assign(job, { payout_deferred: 1, refunded_to_holding: a.refundedToHolding ? 1 : 0 })
        break
      case 'RefundDeferred':
        job.refund_deferred = 1
        break
      case 'ToppedUp':
        job.bonus = a.bonus as string
        out.push(stmt('INSERT INTO top_ups (chain_id, job_id, block, log_index, contributor, amount, refunded, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          chainId, jobId, e.block, e.logIndex, a.contributor as string, a.amount as string, 0, e.txHash))
        break
      case 'TopUpRefunded':
        out.push(stmt('INSERT INTO top_ups (chain_id, job_id, block, log_index, contributor, amount, refunded, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          chainId, jobId, e.block, e.logIndex, a.contributor as string, a.amount as string, 1, e.txHash))
        break
      case 'FeeCharged':
        Object.assign(job, { charged_fee: a.amount, bonus_fee: a.bonusPart })
        out.push(stmt('INSERT INTO fee_charges (chain_id, job_id, block, log_index, token, worker, creator, amount, bonus_part, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          chainId, jobId, e.block, e.logIndex, a.token as string, a.worker as string, a.creator as string, a.amount as string, a.bonusPart as string, e.txHash))
        break
      case 'PayoutOwed':
        out.push(stmt('INSERT INTO payout_owed (chain_id, job_id, block, log_index, recipient, token, amount, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          chainId, jobId, e.block, e.logIndex, a.to as string, a.token as string, a.amount as string, e.txHash))
        break
      case 'JobCompleted':
        job.status = 'completed'
        break
      case 'JobRejected':
        job.status = 'rejected'
        break
      case 'JobExpired':
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
        job.settlement_outcome = SETTLEMENT_OUTCOMES[Number(a.outcome)] ?? null
        const owed = ordered.some((other) => other.txHash === e.txHash && other.name === 'PayoutOwed'
          && String(other.args.to).toLowerCase() === String(a.to).toLowerCase())
        out.push(stmt('INSERT INTO reward_outcomes (chain_id, job_id, block, log_index, kind, recipient, amount, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          chainId, jobId, e.block, e.logIndex, owed ? 'owed' : Number(a.outcome) === 1 ? 'paid' : 'refunded',
          a.to as string, a.amount as string, e.txHash))
        break
      case 'BondReleased':
      case 'BondSlashed':
        out.push(stmt('INSERT INTO bond_outcomes (chain_id, job_id, block, log_index, side, outcome, recipient, amount, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          chainId, jobId, e.block, e.logIndex, SIDES[Number(a.side)] ?? String(a.side), e.name === 'BondSlashed' ? 'burned' : 'returned',
          a.account as string, a.amount as string, e.txHash))
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
    'stack', 'mode', 'creator', 'approver', 'token', 'reward', 'creator_bond', 'worker_bond', 'policy_hash', 'manifest_hash', 'delivery_deadline',
    'selection_deadline', 'worker', 'agent_id', 'status', 'deliverable', 'violation', 'rejection_reason_hash', 'published_block', 'published_tx',
    'kind', 'arbitrator', 'expired_at', 'review_window', 'dispute_window', 'arbitration_window', 'fee_bps', 'fee', 'net', 'bonus',
    'outcome', 'settlement_outcome', 'charged_fee', 'bonus_fee', 'payout_deferred', 'refund_deferred', 'refunded_to_holding',
  ] as const
  out.push(stmt(
    `INSERT INTO jobs (chain_id, job_id, ${columns.join(', ')}, updated_block) VALUES (${['?', '?', ...columns.map(() => '?'), '?'].join(', ')})`,
    chainId, jobId, ...columns.map((c) => job[c] ?? null), last.block,
  ))
  return out
}
