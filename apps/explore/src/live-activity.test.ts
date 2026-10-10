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
})
