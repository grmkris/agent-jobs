import { expect, it } from 'vitest'
import { publisherFunding, publisherNextAction } from './publisher-view.ts'
import type { ChainView } from './service.ts'

const view: ChainView = { status: 'active', coreStatus: 'Funded', listingMatchesOffer: true, provider: '0x1111111111111111111111111111111111111111', submittedAt: null, timely: true, deliveryDeadline: 2000, reviewEndsAt: 2100, disputeEndsAt: 2200, arbitrationEndsAt: 2300, violation: null }
it('derives deadlines and permissionless timeout actors from the frozen chain windows', () => {
  expect(publisherNextAction(view, 1000)).toEqual({ actor: 'worker', action: 'submit_work', deadline: 2000 })
  expect(publisherNextAction(view, 2001)).toEqual({ actor: 'anyone', action: 'settle_missed_delivery', deadline: null })
  expect(publisherNextAction({ ...view, status: 'submitted' }, 2100)).toEqual({ actor: 'approver', action: 'approve_or_reject', deadline: 2100 })
  expect(publisherNextAction({ ...view, status: 'submitted' }, 2101)?.actor).toBe('anyone')
  expect(publisherNextAction({ ...view, status: 'rejected-pending' }, 2100)?.deadline).toBe(2200)
  expect(publisherNextAction({ ...view, status: 'disputed' }, 2100)?.deadline).toBe(2300)
  expect(publisherNextAction({ ...view, status: 'completed', deferredDecision: true }, 2100)?.action).toBe('retry_deferred_then_settle')
  expect(publisherFunding({ ...view, status: 'completed' }).state).toBe('terminal-see-settlement')
  expect(publisherFunding({ ...view, listingMatchesOffer: false }).state).toBe('unknown')
})
