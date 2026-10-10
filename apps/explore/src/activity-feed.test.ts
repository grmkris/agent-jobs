import type { Phase } from '@sidequest/react'
import type { JobTag } from '@sidequest/sdk'
import { describe, expect, it } from 'vitest'
import {
  type FeedFilter,
  NO_FILTER,
  bucketCounts,
  bucketOf,
  draftsOf,
  feedEvents,
  feedJobs,
  matches,
  posterParty,
  progressOf,
  readFilter,
  visibleEvents,
  writeFilter,
} from './activity-feed.ts'
import type { ChainJob, QuoteRequest, TaskIndexEntry } from './api.ts'
import type { JobListItem } from './job-list.ts'
import type { ActivityStep } from './live-activity.ts'

const POSTER = '0x5760b5e2E1314BCd7d43E259Bd12485cc5A22aAE'
const WORKER = '0x77899d992e137F2616dfaF5e832A1BD462AcE1c1'
const NOW = 1_000_000

const step = (jobId: string, s: ActivityStep['step'], at: number | null, extra: Partial<ActivityStep> = {}) => ({
  jobId,
  step: s,
  at,
  txHash: `0x${jobId}${s}`,
  boardId: null,
  agentId: null,
  ...extra,
})

function job(jobId: string, status: string, extra: { title?: string; tags?: JobTag[]; taskId?: string } = {}) {
  // SAFETY: the feed reads only these chain columns; the lifecycle treats the rest as unknown.
  const chain = {
    job_id: jobId,
    kind: 'sidequest-v1',
    status,
    creator: POSTER,
    approver: POSTER,
    worker: status === 'open' ? null : WORKER,
    agent_id: status === 'open' ? '0' : '2036',
    delivery_deadline: NOW + 3600,
    worker_bond: '0',
  } as ChainJob
  const offer: Partial<TaskIndexEntry> = {
    taskId: extra.taskId ?? `t${jobId}`,
    jobId,
    title: extra.title ?? `Job ${jobId}`,
    tags: extra.tags ?? [],
    creator: POSTER,
    createdAt: 100 + Number(jobId),
  }
  // SAFETY: the feed reads the offer's id, title, tags, creator and posting time.
  const task = offer as TaskIndexEntry
  return { jobId, chain, task }
}

// SAFETY: the feed reads a request's id, title, creator, timing, pick and claimed agent.
const request = (requestId: string, createdAt: number, extra: Partial<QuoteRequest> = {}) =>
  ({
    requestId,
    createdAt,
    title: `Request ${requestId}`,
    creator: POSTER,
    creatorAgentId: null,
    quoteDeadline: NOW + 600,
    quotesCount: 0,
    taskId: null,
    ...extra,
  }) as QuoteRequest

// SAFETY: bucketOf reads only the phase's key and beneficiary.
const phase = (key: Phase['key'], beneficiary: 'worker' | 'creator' | null = null) => ({ key, beneficiary }) as Phase
const f = (over: Partial<FeedFilter>): FeedFilter => ({ ...NO_FILTER, ...over })
const read = (search: string) => readFilter(new URLSearchParams(search))

const posters = new Map([[POSTER.toLowerCase(), '2030']])
const build = (items: JobListItem[], requests: QuoteRequest[] = [], steps: ActivityStep[] = []) =>
  feedJobs({ items, requests, steps, posters, viewer: undefined, now: NOW })

describe('activity feed jobs', () => {
  it('files each phase under one step filter, a paid deferral with paid and a refund with closed', () => {
    expect(bucketOf(phase('quotes-open'))).toBe('open')
    expect(bucketOf(phase('hire-open'))).toBe('open')
    expect(bucketOf(phase('overdue'))).toBe('progress')
    expect(bucketOf(phase('accepted-by-silence'))).toBe('review')
    expect(bucketOf(phase('disputed'))).toBe('disputes')
    expect(bucketOf(phase('hire-lapsed'))).toBe('closed')
    expect(bucketOf(phase('payout-deferred', 'worker'))).toBe('paid')
    expect(bucketOf(phase('collect', 'creator'))).toBe('closed')
    expect(bucketOf(phase('draft'))).toBeNull()
    expect(bucketOf(null)).toBeNull()
  })

  it('folds a picked request into its job, keeps an open one as its own row and leaves drafts out', () => {
    const draft: JobListItem = { jobId: null, chain: undefined, task: { ...job('0', 'open').task, jobId: null } }
    const jobs = build(
      [job('12', 'completed', { taskId: 'picked' }), draft],
      [request('r-picked', 50, { taskId: 'picked', creatorAgentId: '2029' }), request('r-open', 900)],
    )
    expect(jobs.map((j) => j.key)).toEqual(['request:r-open', '12'])
    expect(jobs[1]).toMatchObject({ posterAgent: '2029', workerAgent: '2036', bucket: 'paid' })
    expect(jobs[1]?.requested?.requestId).toBe('r-picked')
    expect(jobs[0]).toMatchObject({ posterAgent: '2030', workerAgent: null, bucket: 'open' })
    expect(draftsOf([draft], POSTER.toUpperCase())).toEqual([draft])
    expect(draftsOf([draft], undefined)).toEqual([])
  })

  it('orders by the newest loaded step, else by when the work was posted', () => {
    const jobs = build(
      [job('4', 'completed'), job('5', 'active'), job('6', 'open')],
      [],
      [step('4', 'completed', 700), step('4', 'posted', 300), step('5', 'hired', 500), step('5', 'hired', 500)],
    )
    expect(jobs.map((j) => [j.item.jobId, j.latestAt, j.stepped])).toEqual([
      ['4', 700, true],
      ['5', 500, true],
      ['6', 106, false],
    ])
    expect(jobs[0]?.steps.map((s) => s.step)).toEqual(['posted', 'completed'])
    expect(jobs[1]?.steps).toHaveLength(1)
  })

  it('matches by step, tags, text or job number, agent and the viewer', () => {
    const [paid, open] = build([
      job('11', 'completed', { title: 'Explainer video', tags: ['design'] }),
      job('3', 'open', { title: 'Memo', tags: ['research'] }),
    ])
    expect(matches(paid!, f({ step: 'paid' }), undefined)).toBe(true)
    expect(matches(open!, f({ step: 'paid' }), undefined)).toBe(false)
    expect(matches(paid!, f({ tags: ['research', 'design'] }), undefined)).toBe(true)
    expect(matches(open!, f({ tags: ['design'] }), undefined)).toBe(false)
    expect(matches(paid!, f({ q: 'VIDEO' }), undefined)).toBe(true)
    expect(matches(paid!, f({ q: '#11' }), undefined)).toBe(true)
    expect(matches(paid!, f({ agent: '2036' }), undefined)).toBe(true)
    expect(matches(paid!, f({ agent: '2030' }), undefined)).toBe(true)
    expect(matches(open!, f({ agent: '2036' }), undefined)).toBe(false)
    expect(matches(paid!, f({ mine: true }), WORKER)).toBe(true)
    expect(matches(paid!, f({ mine: true }), undefined)).toBe(false)
  })

  it('places a job on posted → hired → delivered → paid, or says how it left that path', () => {
    const [paid, active, open, asked] = build(
      [job('3', 'completed'), job('2', 'active'), job('1', 'open')],
      [request('r', 5, { quoteDeadline: 1 })],
    )
    expect(progressOf(paid!)).toEqual({ reached: 4, ending: null })
    expect(progressOf(active!)).toEqual({ reached: 2, ending: null })
    expect(progressOf(open!)).toEqual({ reached: 1, ending: null })
    expect(progressOf(asked!)).toEqual({ reached: 0, ending: 'closed' })
    expect(progressOf(build([job('4', 'cancelled')])[0]!)).toEqual({ reached: 2, ending: 'closed' })
  })

  it('counts each step filter under the other filters', () => {
    const jobs = build([
      job('1', 'completed', { tags: ['design'] }),
      job('2', 'completed', { tags: ['coding'] }),
      job('3', 'active', { tags: ['design'] }),
    ])
    expect(bucketCounts(jobs, { ...NO_FILTER, step: 'progress', tags: ['design'] }, undefined)).toMatchObject({
      all: 2,
      paid: 1,
      progress: 1,
      open: 0,
    })
  })

  it("reads the old list's view links and writes only what is set", () => {
    expect(read('view=open').step).toBe('open')
    expect(read('view=done').step).toBe('paid')
    expect(read('view=mine')).toMatchObject({ mine: true, step: 'all' })
    expect(read('step=disputes&agent=2025&tags=design,bogus&q=x')).toEqual({
      step: 'disputes',
      agent: '2025',
      tags: ['design'],
      q: 'x',
      mine: false,
    })
    expect(read('step=nope&agent=x').step).toBe('all')
    expect(read('agent=x').agent).toBeNull()
    const written = writeFilter(
      { ...NO_FILTER, step: 'paid', tags: ['writing', 'design'] },
      new URLSearchParams('view=open&rows=job'),
    )
    expect(written.toString()).toBe('rows=job&step=paid&tags=design%2Cwriting')
  })
})

describe('activity feed events', () => {
  it('merges job steps and new requests newest first, naming the poster of a posting', () => {
    const jobs = build([job('7', 'active', { title: 'Landing page' })], [request('r1', 200)])
    const events = feedEvents(
      [
        step('7', 'hired', 300, { agentId: '2029' }),
        step('7', 'posted', 100, { token: '0xt', amount: '8' }),
        step('8', 'expired', null),
        step('7', 'hired', 300, { agentId: '2029' }),
      ],
      jobs,
      false,
    )
    expect(events.map((e) => [e.kind, e.title, e.agentId])).toEqual([
      ['hired', 'Landing page', '2029'],
      ['requested', 'Request r1', '2030'],
      ['posted', 'Landing page', '2030'],
    ])
    expect(events[2]?.amount).toBe('8')
  })

  it('names a poster no agent names by its wallet, on postings, requests and as the payer', () => {
    const jobs = feedJobs({
      items: [job('7', 'completed')],
      requests: [request('r1', 200)],
      steps: [],
      posters: new Map(),
      viewer: undefined,
      now: NOW,
    })
    const events = feedEvents([step('7', 'posted', 100), step('7', 'completed', 300, { agentId: '2036' })], jobs, false)
    expect(events.map((e) => [e.kind, e.agentId, e.wallet])).toEqual([
      ['completed', '2036', undefined],
      ['requested', null, POSTER],
      ['posted', null, POSTER],
    ])
    expect(posterParty(jobs.find((j) => j.item.jobId === '7'))).toEqual({ wallet: POSTER })
    expect(posterParty(build([job('8', 'active')])[0])).toEqual({ agent: '2030' })
  })

  it('names an unknown job by number and holds back requests older than the loaded steps', () => {
    const jobs = build([], [request('old', 5), request('new', 50)])
    const events = feedEvents([step('9', 'completed', 10), step('10', 'posted', 40)], jobs, true)
    expect(events.map((e) => e.title)).toEqual(['Request new', 'job #10', 'job #9'])
    expect(feedEvents([], jobs, true)).toEqual([])
    expect(feedEvents([], jobs, false)).toHaveLength(2)
  })

  it("shows an unknown job's events only when nothing is filtered", () => {
    const jobs = build([job('7', 'completed')])
    const events = feedEvents([step('7', 'completed', 9), step('99', 'posted', 8)], jobs, false)
    expect(visibleEvents(events, NO_FILTER, undefined)).toHaveLength(2)
    expect(visibleEvents(events, { ...NO_FILTER, step: 'paid' }, undefined).map((e) => e.jobId)).toEqual(['7'])
  })
})
