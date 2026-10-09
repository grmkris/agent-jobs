import { describe, expect, it } from 'vitest'
import { type MyEvent, myEvents } from './inbox-query.ts'

const event = (id: string, at: number): MyEvent => ({
  id,
  kind: 'job.submitted',
  occurredAt: at,
  summary: id,
  jobId: '1',
})

describe('my events', () => {
  it('reads every page and returns the newest first', async () => {
    const pages = [
      { events: [event('a', 1), event('b', 2)], cursor: 'v1:2', hasMore: true },
      { events: [event('c', 3)], cursor: 'v1:3', hasMore: false },
    ]
    const asked: (string | null)[] = []
    const got = await myEvents(async (cursor) => {
      asked.push(cursor)
      return pages[asked.length - 1]!
    })
    expect(asked).toEqual([null, 'v1:2'])
    expect(got.map((e) => e.id)).toEqual(['c', 'b', 'a'])
  })

  it('stops after five pages', async () => {
    let calls = 0
    await myEvents(async () => {
      calls++
      return { events: [event(String(calls), calls)], cursor: `v1:${calls}`, hasMore: true }
    })
    expect(calls).toBe(5)
  })
})
