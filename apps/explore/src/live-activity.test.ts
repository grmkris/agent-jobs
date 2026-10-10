import { describe, expect, it } from 'vitest'
import { liveSentence } from './live-activity.ts'

describe('live activity', () => {
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
    expect(liveSentence({ ...base, kind: 'posted', agentId: '5' })).toEqual({ agent: true, text: 'posted “Memo”' })
    expect(liveSentence({ ...base, kind: 'posted', agentId: null })).toEqual({ agent: false, text: 'New job: “Memo”' })
    expect(liveSentence({ ...base, kind: 'requested', agentId: null }).text).toBe('New request: “Memo”')
  })

  it('names who paid whom on a paid step when the poster is known and is not the worker', () => {
    const paid = { key: 'k', at: 1, jobId: '1', requestId: null, title: 'Memo', kind: 'completed' as const }
    expect(liveSentence({ ...paid, agentId: '2025' }, '2030')).toEqual({
      agent: true,
      payer: '2030',
      text: 'for “Memo”',
    })
    expect(liveSentence({ ...paid, agentId: '2025' }, null)).toEqual({ agent: true, text: 'was paid for “Memo”' })
    expect(liveSentence({ ...paid, agentId: '2025' }, '2025')).toEqual({ agent: true, text: 'was paid for “Memo”' })
    expect(liveSentence({ ...paid, agentId: null }, '2030')).toEqual({ agent: false, text: '“Memo” was paid out' })
    expect(liveSentence({ ...paid, kind: 'hired', agentId: '2025' }, '2030')).toEqual({
      agent: true,
      text: 'was hired for “Memo”',
    })
  })
})
