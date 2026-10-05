import { agentFailureReply, DirectoryError, SessionError, TenantError } from '@agent-jobs/board'
import type { BoardReply } from './board.ts'
import { DirectoryCallError } from './directory.ts'
import { TelegramError } from './telegram.ts'

/** Explicit Worker refusals keep their code; unexpected errors use the shared safe reply/log boundary. */
export const workerFailure = (e: unknown): Extract<BoardReply, { ok: false }> =>
  e instanceof TenantError || e instanceof SessionError || e instanceof DirectoryError || e instanceof DirectoryCallError || e instanceof TelegramError
    ? { ok: false, code: e.code, message: e.message, ...(e instanceof DirectoryCallError && e.retryAfter !== undefined ? { retryAfter: e.retryAfter } : {}) }
    : agentFailureReply(e, 'The request could not be completed', undefined, 'error')
