import { describe, expect, it } from 'vitest'
import type { ChainJob } from '../../api.ts'
import type { JobListItem } from '../../job-list.ts'
import type { Bucket, FeedEvent, FeedJob } from '../../activity-feed.ts'
import { boardActivityText, landingEvents, liveWorkItems } from './live-work.ts'

const now = 1000
const item = (status: string, deadline = 2000): JobListItem => ({
  jobId: status,
  task: undefined,
  chain: {
    job_id: status,
    stack: 'main',
    kind: 'sidequest-v1',
    mode: 'hire',
    status,
    creator: null,
    approver: null,
    token: null,
    reward: null,
    creator_bond: '0',
    worker_bond: '0',
    worker: null,
    agent_id: null,
    delivery_deadline: deadline,
    selection_deadline: null,
    deliverable: null,
    violation: null,
    published_tx: null,
  } satisfies ChainJob,
})

describe('landing board activity', () => {
  it.each([
    [0, '0 jobs completed · 0 agents have worked here'],
    [1, '1 job completed · 1 agent has worked here'],
    [2, '2 jobs completed · 2 agents have worked here'],
  ] as const)('uses the right nouns and verbs for %i', (count, expected) => {
    expect(boardActivityText(count, count)).toBe(expected)
  })

  it('pluralizes each count independently', () => {
    expect(boardActivityText(1, 2)).toBe('1 job completed · 2 agents have worked here')
    expect(boardActivityText(2, 1)).toBe('2 jobs completed · 1 agent has worked here')
  })
})

describe('landing live work', () => {
  it('keeps open, active, submitted and completed work in the original order', () => {
    const items = ['cancelled', 'open', 'expired', 'active', 'submitted', 'rejected', 'completed', 'disputed'].map(
      (status) => item(status),
    )
    expect(liveWorkItems(items, now).map((row) => row.jobId)).toEqual(['open', 'active', 'submitted', 'completed'])
    expect(items).toHaveLength(8)
  })

  it('excludes lapsed offers, drafts and unconfirmed chain records while keeping overdue active work', () => {
    const items = [
      item('open', now - 1),
      item('active', now - 1),
      { ...item('open'), jobId: null },
      { ...item('open'), chain: undefined },
      item('unknown'),
    ]
    expect(liveWorkItems(items, now).map((row) => row.jobId)).toEqual(['active'])
  })

  it('leaves an empty list when every indexed job is cancelled or expired', () => {
    expect(liveWorkItems([item('cancelled'), item('expired')], now)).toEqual([])
    expect(liveWorkItems([], now)).toEqual([])
  })

  it('keeps a completed job when its payout still has to be collected', () => {
    const completed = item('completed')
    const chain = { ...completed.chain!, settlement_outcome: 'None' }
    const pendingCollection = { ...completed, chain }
    expect(liveWorkItems([pendingCollection], now)).toEqual([pendingCollection])
  })
})

const event = (key: string, jobId: string | null, bucket: Bucket | null = null): FeedEvent => ({
  key,
  kind: jobId === null ? 'requested' : 'completed',
  at: 1,
  jobId,
  requestId: jobId === null ? key : null,
  title: key,
  agentId: null,
  // SAFETY: landingEvents reads only an open request's bucket.
  job: jobId === null ? ({ bucket } as FeedJob) : undefined,
})

describe('landing activity', () => {
  it('shows steps on featured jobs and requests still open, up to the limit', () => {
    const events = [
      event('paid', 'completed'),
      event('gone', 'cancelled'),
      event('asking', null, 'open'),
      event('closed', null, 'closed'),
      event('working', 'active'),
    ]
    const items = [item('completed'), item('cancelled'), item('active')]
    expect(landingEvents(events, items, now).map((e) => e.key)).toEqual(['paid', 'asking', 'working'])
    // A job shows once, at its newest step.
    expect(
      landingEvents([event('paid', 'completed'), event('earlier', 'completed')], items, now).map((e) => e.key),
    ).toEqual(['paid'])
    expect(landingEvents(events, items, now, 2)).toHaveLength(2)
  })
})
