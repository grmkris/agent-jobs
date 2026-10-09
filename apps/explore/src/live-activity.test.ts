import { describe, expect, it } from 'vitest'
import { type ActivityStep, liveItems, liveSentence } from './live-activity.ts'

const step = (
  jobId: string,
  s: ActivityStep['step'],
  at: number | null,
  extra: Partial<ActivityStep> = {},
): ActivityStep => ({
  jobId,
  step: s,
  at,
  txHash: `0x${jobId}${s}`,
  boardId: null,
  agentId: null,
  ...extra,
})

describe('live activity', () => {
  it('merges job steps and new requests newest first, with titles from the list', () => {
    const items = liveItems(
      [
        step('7', 'hired', 300, { agentId: '2029' }),
        step('7', 'posted', 100, { token: '0xt', amount: '8' }),
        step('8', 'expired', null),
      ],
      [{ requestId: 'r1', createdAt: 200, title: 'Coffee page', creator: '0xAB', creatorAgentId: null }],
      new Map([['7', 'Landing page']]),
      new Map([['0xab', '2030']]),
    )
    expect(items.map((i) => [i.kind, i.title, i.agentId])).toEqual([
      ['hired', 'Landing page', '2029'],
      ['requested', 'Coffee page', '2030'],
      ['posted', 'Landing page', null],
    ])
    expect(items[2]?.amount).toBe('8')
  })

  it('falls back to the job number and keeps at most the limit', () => {
    const items = liveItems(
      [step('9', 'completed', 5), step('10', 'posted', 6)],
      [],
      new Map([['10', '']]),
      new Map(),
      1,
    )
    expect(items.map((i) => i.title)).toEqual(['job #10'])
    expect(
      liveItems(
        Array.from({ length: 9 }, (_, n) => step(String(n), 'posted', n)),
        [],
        new Map(),
        new Map(),
      ),
    ).toHaveLength(5)
  })

  it('names the agent when known and says what happened otherwise', () => {
    const base = { key: 'k', at: 1, jobId: '1', requestId: null, title: 'Memo' }
    expect(liveSentence({ ...base, kind: 'hired', agentId: '5' })).toEqual({
      agent: true,
      text: 'was hired for “Memo”',
    })
    expect(liveSentence({ ...base, kind: 'hired', agentId: null })).toEqual({
      agent: false,
      text: 'An agent was hired for “Memo”',
    })
    expect(liveSentence({ ...base, kind: 'posted', agentId: '5' })).toEqual({ agent: false, text: 'New job: “Memo”' })
    expect(liveSentence({ ...base, kind: 'requested', agentId: null }).text).toBe('New request: “Memo”')
  })
})
