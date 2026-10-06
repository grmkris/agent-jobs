import { DirectoryError, SessionError, TenantError } from '@sidequest/board'
import { describe, expect, it, vi } from 'vitest'
import { DirectoryCallError } from '../src/directory.ts'
import { TelegramError } from '../src/telegram.ts'
import { workerFailure } from '../src/worker-failure.ts'

const credentials = [
  new Error('Authorization: Bearer SECRETKEY'),
  Object.assign(new TypeError('upstream refused {apiKey:short}'), { code: 'rate-limited', status: 429, body: '{"apiKey":"sk-1"}', details: 'x-api-key: ab12' }),
  'Authorization: Bearer SECRETKEY {apiKey:short}',
]

describe('API worker failures', () => {
  it.each(credentials.map((_, index) => index))('hides unexpected credential text in failure %s from HTTP replies and logs', (index) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const reply = workerFailure(credentials[index])
      expect(reply).toMatchObject({ ok: false, code: 'error', reason: 'internal', retry: 'same-key', errorId: expect.stringMatching(/^[0-9a-f]{12}$/) })
      expect(reply.message).toBe(`The request could not be completed (error ${reply.errorId}); retry the same operationKey`)
      expect(log).toHaveBeenCalledTimes(1)
      const { at, ...diagnostics } = JSON.parse(log.mock.calls[0]![0]) as { at?: unknown }
      expect(diagnostics).toEqual({ event: 'agent-failure', errorId: reply.errorId, name: ['Error', 'TypeError', 'string'][index], ...(index === 1 ? { code: 'rate-limited', status: 429 } : {}) })
      // Where it was thrown, as function names only.
      if (at !== undefined) for (const frame of at as string[]) expect(frame).toMatch(/^[\w$#.<>]+$/)
      expect(JSON.stringify([reply, log.mock.calls])).not.toMatch(/Authorization|Bearer|SECRETKEY|apiKey|short|sk-1|ab12|x-api-key|upstream|refused/)
    } finally { log.mockRestore() }
  })

  it.each([
    new TenantError('invalid', 'Unsupported tenant token'),
    new SessionError('forbidden', 'Sign in first'),
    new DirectoryError('not-found', 'Worker not found'),
    new DirectoryCallError('rate-limited', 'Wait before posting again', 30),
    new TelegramError('unavailable', 'Telegram is not configured'),
  ])('keeps the explicit $code refusal and retry delay', (error) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(workerFailure(error)).toEqual({ ok: false, code: error.code, message: error.message, ...(error instanceof DirectoryCallError ? { retryAfter: 30 } : {}) })
      expect(log).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  })
})
