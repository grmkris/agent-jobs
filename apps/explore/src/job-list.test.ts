import { quoteRequestPhase, type Phase } from '@sidequest/react'
import { describe, expect, it } from 'vitest'
import type { QuoteRequest } from './api.ts'
import { type JobListItem, listPhase, postedAt, rowCountdown, sortRows, viewOf } from './job-list.ts'

const creator = '0x1111111111111111111111111111111111111111'
const viewer = '0x2222222222222222222222222222222222222222'
const phase = (key: Phase['key'], deadline: number | null, terminal = false) => ({ key, deadline, terminal, roles: [], label: key }) as unknown as Phase
const request = (id: string, createdAt: number) => ({ requestId: id, createdAt, creator }) as unknown as QuoteRequest
const row = (item: Partial<JobListItem>, p: Phase) => ({ item: { jobId: null, task: undefined, chain: undefined, ...item }, phase: p })

describe('the single Jobs list', () => {
  it('files quote requests with open, closed ones with done', () => {
    expect(viewOf(quoteRequestPhase({ quoteDeadline: 2000, quotes: 3, picked: false, creator }, viewer, 1000))).toBe('open')
    expect(viewOf(quoteRequestPhase({ quoteDeadline: 900, quotes: 0, picked: false, creator }, viewer, 1000))).toBe('done')
    expect(viewOf(phase('hire-open', 5000))).toBe('open')
    expect(viewOf(phase('active', 5000))).toBe('progress')
    expect(viewOf(phase('completed', null, true))).toBe('done')
  })

  it('a closed request reads "Closed · no pick" to everyone but its poster, who may still pick', () => {
    const closed = (who: string) => listPhase(quoteRequestPhase({ quoteDeadline: 900, quotes: 2, picked: false, creator }, who, 1000))
    expect(closed(viewer).label).toBe('Closed · no pick')
    expect(closed(creator)).toMatchObject({ label: 'Quotes closed', youAct: true })
  })

  it('counts down to the deadline that moves the work on, in words for its phase', () => {
    expect(rowCountdown(phase('quotes-open', 2000))).toEqual({ verb: 'closes', to: 2000, passed: 'closed' })
    expect(rowCountdown(phase('active', 3000))).toEqual({ verb: 'due', to: 3000, passed: 'overdue' })
    expect(rowCountdown(phase('in-review', 4000))).toEqual({ verb: 'pays in', to: 4000, passed: 'payable' })
    expect(rowCountdown(phase('completed', null, true))).toBeNull()
    expect(rowCountdown(phase('overdue', 100))).toBeNull()
  })

  it('puts open work first by soonest deadline, then the rest newest first', () => {
    const rows = [
      row({ jobId: '5', task: { createdAt: 500 } as never }, phase('completed', null, true)),
      row({ request: request('late', 700) }, phase('quotes-open', 9000)),
      row({ jobId: '7', task: { createdAt: 900 } as never }, phase('active', 3000)),
      row({ request: request('soon', 100) }, phase('quotes-open', 2000)),
      row({ jobId: '6', task: { createdAt: 800 } as never }, phase('hire-open', 5000)),
    ]
    expect(sortRows(rows).map(r => r.item.request?.requestId ?? r.item.jobId)).toEqual(['soon', '6', 'late', '7', '5'])
    expect(postedAt(rows[1]!.item)).toBe(700)
  })
})
