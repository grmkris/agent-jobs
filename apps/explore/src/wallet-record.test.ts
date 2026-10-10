import { describe, expect, it } from 'vitest'
import type { Bucket, FeedJob } from './activity-feed.ts'
import type { ChainJob, QuoteRequest } from './api.ts'
import { hasHistory, walletRecord } from './wallet-record.ts'

const ME = '0x21D0fd0000000000000000000000000000000001'
const OTHER = '0x5f3d000000000000000000000000000000000002'
const MUSD = '0x6B56D64150818f91f5112B285e806ec6C78EADe8'
const SIDE = '0xbf0A7336d774729af63d415b5A6bDae8731b2e9B'

/** A chain job in a feed: who posted and approves it, its reward and where it stands. */
function job(
  jobId: string,
  bucket: Bucket,
  over: { creator?: string; approver?: string; reward?: string; token?: string; worker?: string | null } = {},
): FeedJob {
  const creator = over.creator ?? ME
  // SAFETY: the record reads a chain job's creator, approver, token and reward only.
  const chain = {
    job_id: jobId,
    creator,
    approver: over.approver ?? creator,
    token: over.token ?? MUSD,
    reward: over.reward ?? '1000000',
  } as ChainJob
  return {
    key: jobId,
    item: { jobId, chain, task: undefined },
    phase: null,
    bucket,
    posterAgent: null,
    workerAgent: over.worker === undefined ? '2024' : over.worker,
    requested: null,
    steps: [],
    latestAt: null,
    stepped: false,
  }
}

/** A quote request in a feed, open or closed. */
function asked(requestId: string, bucket: Bucket, creator = ME): FeedJob {
  // SAFETY: the record reads a request's creator only.
  const request = { requestId, creator } as QuoteRequest
  return {
    key: `request:${requestId}`,
    item: { jobId: null, chain: undefined, task: undefined, request },
    phase: null,
    bucket,
    posterAgent: null,
    workerAgent: null,
    requested: null,
    steps: [],
    latestAt: null,
    stepped: false,
  }
}

describe('walletRecord', () => {
  it('counts what a wallet posted and what became of it, with its money per token', () => {
    const feed = [
      job('1', 'paid', { reward: '3500000' }),
      job('2', 'paid', { reward: '4200000', worker: '2036' }),
      job('3', 'paid', { reward: '5000000000000000000', token: SIDE, worker: '2036' }),
      job('4', 'progress', { reward: '2000000' }),
      job('5', 'disputes', { reward: '1000000' }),
      job('6', 'closed', { worker: null }),
      job('7', 'open', { reward: '500000', worker: null }),
      job('8', 'paid', { creator: OTHER }),
    ]
    const record = walletRecord(feed, ME.toLowerCase())
    expect(record).toMatchObject({ posted: 7, paidJobs: 3, refunded: 1, disputes: 1, approves: 0 })
    expect(record.paid).toEqual([
      { token: SIDE, value: '5000000000000000000' },
      { token: MUSD, value: '7700000' },
    ])
    expect(record.escrow).toEqual([{ token: MUSD, value: '3500000' }])
    expect(record.hired).toEqual([
      { agentId: '2024', jobs: 3 },
      { agentId: '2036', jobs: 2 },
    ])
  })

  it('lists its open requests, the jobs it approves for others, and says when it has no history', () => {
    const feed = [
      asked('r1', 'open'),
      asked('r2', 'closed'),
      asked('r3', 'open', OTHER),
      job('9', 'review', { creator: OTHER, approver: ME }),
    ]
    const record = walletRecord(feed, ME)
    expect(record.openRequests.map((r) => r.key)).toEqual(['request:r1'])
    expect(record.approves).toBe(1)
    expect(record.posted).toBe(0)
    expect(hasHistory(record)).toBe(true)
    expect(hasHistory(walletRecord(feed, '0x0000000000000000000000000000000000000009'))).toBe(false)
  })
})
