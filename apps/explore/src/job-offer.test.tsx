import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { HostedBy, JobOfferBrief, OfferIdentity, jobOfferFields, type ForeignOffer } from './job-offer.tsx'
import { titleOf, tagsOf, type JobListItem } from './job-list.ts'
import type { TaskIndexEntry } from './api.ts'

const foreign: ForeignOffer = {
  origin: 'https://dev.sidequest.exchange',
  termsHash: `0x${'ab'.repeat(32)}`,
  terms: {
    title: 'A job hosted elsewhere',
    brief: 'A verified foreign brief.',
    acceptanceCriteria: ['Readable across boards'],
    quote: null,
    tags: ['coding'],
    windows: { reviewSeconds: 120, disputeSeconds: 120, arbitrationSeconds: 300 },
  },
}

it('uses foreign titles and tags in the list while preferring local offer fields', () => {
  const item: JobListItem = {
    jobId: '7',
    task: undefined,
    chain: {
      job_id: '7',
      stack: 'main',
      kind: 'sidequest-v1',
      mode: 'hire',
      status: 'open',
      creator: null,
      approver: null,
      token: null,
      reward: null,
      creator_bond: null,
      worker_bond: null,
      worker: null,
      agent_id: null,
      delivery_deadline: null,
      selection_deadline: null,
      deliverable: null,
      violation: null,
      published_tx: null,
      foreign_offer: foreign,
    },
  }
  expect(titleOf(item)).toBe(foreign.terms.title)
  expect(tagsOf(item)).toEqual(['coding'])
  const local: TaskIndexEntry = {
    taskId: 'local',
    jobId: '7',
    stack: 'main',
    kind: 'sidequest-v1',
    title: 'Local title',
    brief: 'Local brief',
    acceptanceCriteria: [],
    tags: ['research'],
    mode: 'hire',
    token: `0x${'11'.repeat(20)}`,
    reward: '100',
    creatorBond: '0',
    workerBond: '0',
    creator: `0x${'22'.repeat(20)}`,
    approver: `0x${'22'.repeat(20)}`,
    deliveryDeadline: 10000,
    requiredChecks: [],
    quoted: false,
    executionBudget: null,
    termsHash: foreign.termsHash,
    manifestUrl: '/offers/local.json',
    screening: { verdict: 'clean', reasons: [] },
    createdAt: 1000,
  }
  item.task = local
  expect(titleOf(item)).toBe('Local title')
  expect(tagsOf(item)).toEqual(['research'])
})

it('renders the foreign brief, criteria, host and real manifest link used on the job page', () => {
  const offer = jobOfferFields({ jobId: '7', foreign })
  expect(offer.title).toBe(foreign.terms.title)
  expect(offer.windows).toEqual(foreign.terms.windows)
  expect(renderToStaticMarkup(<JobOfferBrief offer={offer} />)).toContain('A verified foreign brief.')
  expect(renderToStaticMarkup(<JobOfferBrief offer={offer} />)).toContain('Readable across boards')
  expect(renderToStaticMarkup(<HostedBy origin={offer.origin} />)).toContain('hosted by dev.sidequest.exchange')
  const link = renderToStaticMarkup(<OfferIdentity offer={offer} />)
  expect(link).toContain(`href="${foreign.origin}/offers/${foreign.termsHash}.json"`)
  expect(link).not.toContain('href="/offers/')
})

it('shows a missing-offer message without a broken local manifest link', () => {
  const offer = jobOfferFields({ jobId: '7', chainHash: foreign.termsHash })
  expect(offer.title).toBe('Job #7')
  const html = renderToStaticMarkup(<OfferIdentity offer={offer} />)
  expect(html).toContain('offer not found on known boards')
  expect(html).not.toContain('href=')
})
