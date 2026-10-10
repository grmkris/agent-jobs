import { describe, expect, it } from 'vitest'
import type { TimelineEvent } from './components/job/Timeline.tsx'
import { milestones } from './job-milestones.ts'

const event = (name: string, at: number, args: TimelineEvent['args'] = {}): TimelineEvent => ({
  name,
  block: at,
  logIndex: 0,
  txHash: `0x${at}`,
  args,
  at,
})

describe('milestones', () => {
  it('dates posted, hired, delivered and paid, and leaves what has not happened yet to come', () => {
    expect(
      milestones([
        event('Published', 100),
        event('Activated', 160),
        event('BondReleased', 170),
        event('JobSubmitted', 400),
        event('PaymentReleased', 520),
      ]),
    ).toEqual([
      { label: 'Posted', state: 'done', at: 100 },
      { label: 'Hired', state: 'done', at: 160 },
      { label: 'Delivered', state: 'done', at: 400 },
      { label: 'Paid', state: 'done', at: 520 },
    ])
    expect(milestones([event('Published', 100), event('Activated', 160)]).map((m) => [m.label, m.state])).toEqual([
      ['Posted', 'done'],
      ['Hired', 'done'],
      ['Delivered', 'todo'],
      ['Paid', 'todo'],
    ])
  })

  it('ends a job that did not pay at what ended it, and counts a ruling for the agent as paid', () => {
    const delivered = [event('Published', 1), event('Activated', 2), event('JobSubmitted', 3)]
    expect(milestones([...delivered, event('Rejected', 4), event('Disputed', 5)]).at(-1)).toEqual({
      label: 'In dispute',
      state: 'failed',
      at: 5,
    })
    expect(
      milestones([
        ...delivered,
        event('Rejected', 4),
        event('Disputed', 5),
        event('Ruled', 6, { forWorker: true }),
        event('RewardSettled', 7, { outcome: 1, amount: '700' }),
      ]).at(-1),
    ).toEqual({ label: 'Paid', state: 'done', at: 7 })
    expect(milestones([event('Published', 1), event('Cancelled', 2)]).map((m) => m.label)).toEqual([
      'Posted',
      'Cancelled',
    ])
    expect(milestones([])).toHaveLength(4)
  })
})
