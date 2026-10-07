import type { ChainView } from './service.ts'

export interface NextAction { actor: string; action: string; deadline: number | null }

/** Deterministic from chain state and the frozen windows. No model or operation receipt can override it. */
export function publisherNextAction(view: ChainView, now: number): NextAction | null {
  if (view.listingMatchesOffer === false) return { actor: 'creator', action: 'verify_listing', deadline: null }
  if (view.deferredDecision || view.collectPending) return { actor: 'anyone', action: 'retry_deferred_then_settle', deadline: null }
  switch (view.status) {
    case 'awaiting-publish': return { actor: 'creator', action: 'publish', deadline: view.deliveryDeadline }
    case 'open': return { actor: 'creator', action: 'select_worker', deadline: view.deliveryDeadline }
    case 'active': return now > view.deliveryDeadline ? { actor: 'anyone', action: 'settle_missed_delivery', deadline: null } : { actor: 'worker', action: 'submit_work', deadline: view.deliveryDeadline }
    case 'submitted': return view.timely && view.reviewEndsAt !== null && now > view.reviewEndsAt
      ? { actor: 'anyone', action: 'complete_after_silence', deadline: null }
      : { actor: 'approver', action: 'approve_or_reject', deadline: view.reviewEndsAt }
    case 'rejected-pending': return view.disputeEndsAt !== null && now > view.disputeEndsAt
      ? { actor: 'anyone', action: 'settle_rejection', deadline: null }
      : { actor: 'worker', action: 'dispute_or_wait', deadline: view.disputeEndsAt }
    case 'disputed': return view.arbitrationEndsAt !== null && now > view.arbitrationEndsAt
      ? { actor: 'anyone', action: 'settle_arbitration_timeout', deadline: null }
      : { actor: 'arbitrator', action: 'rule', deadline: view.arbitrationEndsAt }
    case 'lapsed': return { actor: 'anyone', action: 'settle', deadline: null }
    default: return null
  }
}

export function publisherFunding(view: ChainView) {
  const state = view.status === 'awaiting-publish' ? 'not-escrowed'
    : view.listingMatchesOffer !== true ? 'unknown'
    : ['completed', 'rejected', 'cancelled', 'expired'].includes(view.status) ? 'terminal-see-settlement'
    : 'escrowed'
  return { state, source: 'chain' }
}
