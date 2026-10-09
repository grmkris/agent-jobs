import { expect, it } from 'vitest'
import { decodeJobStepCursor, encodeJobStepCursor, jobStepOfEvent } from './read.ts'

it('maps only public job lifecycle events', () => {
  for (const [event, step] of [
    ['Published', 'posted'],
    ['Activated', 'hired'],
    ['JobSubmitted', 'delivered'],
    ['JobCompleted', 'completed'],
    ['JobRejected', 'rejected'],
    ['Rejected', 'rejected'],
    ['Disputed', 'disputed'],
    ['Ruled', 'ruled'],
    ['Cancelled', 'cancelled'],
    ['JobExpired', 'expired'],
  ])
    expect(jobStepOfEvent(event!)).toBe(step)
})

it('omits settlement, timeout, acceptance and bookkeeping events', () => {
  for (const event of [
    'Accepted',
    'PaymentReleased',
    'RewardSettled',
    'TimedOut',
    'FeeCharged',
    'BondReleased',
    'BondSlashed',
    'FeedbackRecorded',
    'PayoutOwed',
    'PayoutDeferred',
    'RefundDeferred',
    'ToppedUp',
    'EvidenceAttached',
    'QuoteSubmitted',
    'unknown',
    'toString',
    '__proto__',
  ])
    expect(jobStepOfEvent(event)).toBeUndefined()
})

it('round-trips opaque cursors at both ends of the supported integer range', () => {
  for (const cursor of [
    { block: 0, logIndex: 0 },
    { block: 42, logIndex: 7 },
    { block: Number.MAX_SAFE_INTEGER, logIndex: Number.MAX_SAFE_INTEGER },
  ]) {
    const encoded = encodeJobStepCursor(cursor)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeJobStepCursor(encoded)).toEqual(cursor)
  }
})

it('rejects malformed, unbounded and non-integer cursor positions', () => {
  for (const cursor of ['', '!', 'a'.repeat(129), 'not-a-cursor']) expect(decodeJobStepCursor(cursor)).toBeUndefined()
  for (const value of [null, {}, [], [1], [1, 2, 3], ['1', 2], [-1, 0], [1, 0.5], [1e20, 0]])
    expect(decodeJobStepCursor(btoa(JSON.stringify(value)).replace(/=+$/, ''))).toBeUndefined()
})
