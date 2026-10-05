import { describe, expect, it, vi } from 'vitest'
import { AgentFailure, agentFailureReply } from './agent-failure.ts'
import { BoardError } from './board-error.ts'

describe('agentFailureReply', () => {
  it('keeps an agent failure code, reason, retry and wait', () => {
    expect(agentFailureReply(new AgentFailure('conflict', 'This operationKey already names a different action', 'operation-key-reused', 'new-key'), 'fallback'))
      .toEqual({ ok: false, code: 'conflict', message: 'This operationKey already names a different action', reason: 'operation-key-reused', retry: 'new-key' })
    expect(agentFailureReply(new AgentFailure('unavailable', 'grant renews', 'grant-missing', 'same-key', 59.2), 'fallback'))
      .toMatchObject({ retry: 'same-key', retryAfter: 60 })
  })

  it('keeps the fields a sponsor refusal attaches to a BoardError and drops malformed ones', () => {
    const floor = Object.assign(new BoardError('conflict', 'the sponsorship relay is below its balance floor'), { reason: 'floor', retry: 'same-key', retryAfter: 600 })
    expect(agentFailureReply(floor, 'fallback')).toEqual({ ok: false, code: 'conflict', message: 'the sponsorship relay is below its balance floor', reason: 'floor', retry: 'same-key', retryAfter: 600 })
    const odd = Object.assign(new BoardError('conflict', 'x'), { reason: 7, retry: 'later', retryAfter: -1 })
    expect(agentFailureReply(odd, 'fallback')).toEqual({ ok: false, code: 'conflict', message: 'x' })
  })

  it('hides internal error text behind a logged error id', () => {
    const log = vi.fn()
    const secret = new Error('request to https://rpc.example/v2/SECRETKEY failed')
    const reply = agentFailureReply(secret, 'Hosted agent execution failed', log)
    expect(reply).toMatchObject({ ok: false, code: 'unavailable', reason: 'internal', retry: 'same-key' })
    expect(reply.errorId).toMatch(/^[0-9a-f]{12}$/)
    expect(reply.message).toBe(`Hosted agent execution failed (error ${reply.errorId}); retry the same operationKey`)
    expect(JSON.stringify(reply)).not.toContain('SECRETKEY')
    expect(log).toHaveBeenCalledWith(reply.errorId, secret)
  })
})
