import { BoardError } from './board-error.ts'

/** What the caller should do next. `same-key` is safe: the operation journal resumes or reconciles it. */
export type AgentRetry = 'same-key' | 'new-key' | 'after-operator' | 'none'

/** A refusal an agent can act on: a stable reason, a retry rule and, when known, how long to wait. */
export class AgentFailure extends BoardError {
  constructor(
    code: BoardError['code'],
    message: string,
    readonly reason: string,
    readonly retry: AgentRetry,
    readonly retryAfter?: number,
  ) {
    super(code, message)
  }
}

export interface AgentFailureReply {
  readonly ok: false
  readonly code: string
  readonly message: string
  readonly reason?: string
  readonly retry?: AgentRetry
  readonly retryAfter?: number
  readonly errorId?: string
}

const RETRIES = new Set<string>(['same-key', 'new-key', 'after-operator', 'none'])

/**
 * The reply for a failed hosted action. Board errors keep their code, message and any reason, retry and retryAfter
 * (sponsor refusals attach these to a BoardError). Anything else is internal: its text may carry RPC URLs or keys,
 * so the caller sees only an error id that the server logs beside the real error.
 */
export function agentFailureReply(error: unknown, fallback: string, log: (errorId: string, error: unknown) => void = defaultLog): AgentFailureReply {
  if (error instanceof BoardError) {
    const extra = error as unknown as { reason?: unknown; retry?: unknown; retryAfter?: unknown }
    return {
      ok: false, code: error.code, message: error.message,
      ...(typeof extra.reason === 'string' ? { reason: extra.reason } : {}),
      ...(typeof extra.retry === 'string' && RETRIES.has(extra.retry) ? { retry: extra.retry as AgentRetry } : {}),
      ...(typeof extra.retryAfter === 'number' && Number.isFinite(extra.retryAfter) && extra.retryAfter > 0 ? { retryAfter: Math.ceil(extra.retryAfter) } : {}),
    }
  }
  const errorId = Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => byte.toString(16).padStart(2, '0')).join('')
  log(errorId, error)
  return { ok: false, code: 'unavailable', message: `${fallback} (error ${errorId}); retry the same operationKey`, reason: 'internal', retry: 'same-key', errorId }
}

function defaultLog(errorId: string, error: unknown): void {
  console.error(JSON.stringify({ event: 'agent-failure', errorId, ...errorDiagnostics(error) }))
}

/** URLs, then any 20+ character token (API keys, bearer tokens, hashes): what a credentialed RPC error could carry. */
const redact = (text: string): string => text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]').replace(/[A-Za-z0-9_+/=-]{20,}/g, '[redacted]').slice(0, 200)

/**
 * Bounded facts about an error for Worker logs: its class name, a short code or HTTP status when present, and a
 * message with URLs and long tokens removed. Never the raw message, cause or response body.
 */
export function errorDiagnostics(error: unknown): { name: string; code?: string; status?: number; message?: string } {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { name?: unknown; code?: unknown; status?: unknown; message?: unknown }
  return {
    name: typeof e.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.name) ? e.name : typeof error,
    ...(typeof e.code === 'string' && /^[a-z][a-z-]{0,31}$/.test(e.code) ? { code: e.code } : {}),
    ...(typeof e.status === 'number' && Number.isSafeInteger(e.status) ? { status: e.status } : {}),
    ...(typeof e.message === 'string' ? { message: redact(e.message) } : {}),
  }
}
