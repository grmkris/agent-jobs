import { describe, expect, it } from 'vitest'
import type { FeedEvent, FeedJob } from './activity-feed.ts'
import type { ChainJob } from './api.ts'
import type { JobListItem } from './job-list.ts'
import {
  agentEvents,
  isNew,
  moneyLines,
  needsYou,
  offFeedJobs,
  sinceDay,
  success,
  tierProgress,
} from './agent-stats.ts'
import type { AgentRecord, RecordJob } from './routes/Agent.tsx'
import { registerTokens } from './format.ts'

const six = '0x00000000000000000000000000000000000000a6'
const eighteen = '0x00000000000000000000000000000000000000b8'
registerTokens([
  { address: six, symbol: 'SIX', decimals: 6 },
  { address: eighteen, symbol: 'EIGHTEEN', decimals: 18 },
])

const AGENT_WALLET = '0x00000000000000000000000000000000000000aa'

/** A feed job with only what agentEvents reads: the agents on it and the chain parties `involves` checks. */
function feedJob(jobId: string, worker: string | null, poster: string | null, creator = '0x01'): FeedJob {
  // SAFETY: `involves` reads the chain's creator, approver and worker only.
  const chain = { creator, approver: creator, worker: null } as ChainJob
  // SAFETY: agentEvents and `involves` read the job id and the chain row only.
  const item = { jobId, chain } as JobListItem
  return {
    key: jobId,
    item,
    phase: null,
    bucket: null,
    posterAgent: poster,
    workerAgent: worker,
    requested: null,
    steps: [],
    latestAt: null,
    stepped: false,
  }
}

function event(key: string, jobId: string | null, job: FeedJob | undefined): FeedEvent {
  return { key, kind: 'completed', at: 0, jobId, requestId: jobId === null ? key : null, title: '', agentId: null, job }
}

// SAFETY: offFeedJobs reads the job id alone.
const recordJob = (job_id: string) => ({ job_id }) as RecordJob

describe('agent profile numbers', () => {
  it('counts success over settled jobs only, and shows a rate from the third', () => {
    expect(success({ completed: 2, lost: 0 })).toEqual({ settled: 2, paid: 2, rate: null })
    expect(success({ completed: 11, lost: 1 })).toEqual({ settled: 12, paid: 11, rate: 11 / 12 })
    expect(success({ completed: 0, lost: 0 })).toEqual({ settled: 0, paid: 0, rate: null })
  })

  it('orders money by size across decimals, drops zero totals and counts the rest as "+N more"', () => {
    const totals = {
      [eighteen]: { gross: '2000000000000000000', fee: '0', net: '2000000000000000000' }, // 2
      [six]: { gross: '5000000', fee: '500000', net: '4500000' }, // 5
      '0x00000000000000000000000000000000000000c0': { gross: '0', fee: '0', net: '0' },
    }
    const { lines, more, all } = moneyLines(totals, 1)
    expect(lines.map((l) => l.token)).toEqual([six])
    expect(all.map((l) => l.token)).toEqual([six, eighteen])
    expect(more).toBe(1)
    expect(moneyLines(undefined)).toEqual({ lines: [], all: [], more: 0 })
  })

  it('lists the jobs an agent took or posted once each, and keeps steps of jobs the page cannot read', () => {
    const events = [
      event('a2', '7', feedJob('7', '42', null)),
      event('a1', '7', feedJob('7', '42', null)),
      event('b', '8', feedJob('8', '9', '42')),
      event('c', '9', feedJob('9', '9', null, AGENT_WALLET)),
      event('d', '10', feedJob('10', '9', null)),
      event('e', '11', undefined),
    ]
    expect(agentEvents(events, '42', [AGENT_WALLET]).map((e) => e.key)).toEqual(['a2', 'b', 'c', 'e'])
  })

  it('keeps the record jobs no listed event stands for, taken and posted once each, newest first', () => {
    // SAFETY: offFeedJobs reads the jobs it took and posted, and their ids alone.
    const record = {
      jobs: [recordJob('3'), recordJob('12'), recordJob('5')],
      posted: [recordJob('5'), recordJob('20')],
    } as AgentRecord
    const shown = [event('x', '12', undefined), event('y', null, undefined)]
    expect(offFeedJobs(record, shown).map((x) => x.job_id)).toEqual(['20', '5', '3'])
  })

  it('measures fee-tier progress from the current threshold to the next', () => {
    const E = 10n ** 18n
    expect(tierProgress(100n * E, { threshold: 0n, nextThreshold: 10_000n * E })).toBe(0.01)
    expect(tierProgress(10_000n * E, { threshold: 10_000n * E, nextThreshold: 100_000n * E })).toBe(0)
    expect(tierProgress(5n, { threshold: 0n, nextThreshold: null })).toBe(1)
    expect(tierProgress(200n, { threshold: 0n, nextThreshold: 100n })).toBe(1)
  })

  it('treats an agent with no taken and no posted job as new', () => {
    expect(isNew(null)).toBe(true)
    expect(isNew({ agent: { jobs: 0 }, hiring: { posted: 0 } })).toBe(true)
    expect(isNew({ agent: { jobs: 0 }, hiring: { posted: 2 } })).toBe(false)
    expect(isNew({ agent: { jobs: 1 } })).toBe(false)
  })

  it('lists what the owner should act on, most urgent first, and nothing when all is well', () => {
    const calm = {
      pendingApprovals: 0,
      taken: [],
      posted: [],
      allowances: [],
      revoked: false,
      onchainDisabled: false,
      now: 100,
    }
    expect(needsYou(calm)).toEqual([])
    const busy = needsYou({
      pendingApprovals: 2,
      taken: [
        { job_id: '7', status: 'active', delivery_deadline: 50 },
        { job_id: '8', status: 'active', delivery_deadline: 500 },
        { job_id: '9', status: 'submitted', delivery_deadline: 50 },
      ],
      posted: [
        { job_id: '11', status: 'submitted' },
        { job_id: '12', status: 'open' },
      ],
      allowances: [
        { token: '0xa', left: '10', limit: '100' },
        { token: '0xb', left: '50', limit: '100' },
      ],
      revoked: true,
      onchainDisabled: false,
      now: 100,
    })
    expect(busy).toEqual([
      { kind: 'approvals', count: 2 },
      { kind: 'overdue', jobIds: ['7'] },
      { kind: 'review', jobIds: ['11'] },
      { kind: 'budget', token: '0xa', left: '10', limit: '100' },
      { kind: 'revocation' },
    ])
    expect(needsYou({ ...calm, revoked: true, onchainDisabled: true })).toEqual([])
    // VV2-032: an approved operation that did not finish needs the owner too, right after waiting decisions.
    expect(needsYou({ ...calm, pendingApprovals: 1, unfinishedApprovals: 2, revoked: true })).toEqual([
      { kind: 'approvals', count: 1 },
      { kind: 'unfinished', count: 2 },
      { kind: 'revocation' },
    ])
  })

  it('says since when as a day, with the year only when it is not this one', () => {
    const now = Date.UTC(2026, 9, 6) / 1000
    const thisYear = sinceDay(Date.UTC(2026, 8, 6, 12) / 1000, now)
    expect(thisYear).not.toMatch(/2026/)
    expect(thisYear).toMatch(/6/)
    expect(thisYear).not.toMatch(/Sun|Mon|Tue|Wed|Thu|Fri|Sat/)
    expect(sinceDay(Date.UTC(2025, 8, 6, 12) / 1000, now)).toMatch(/2025/)
  })
})
