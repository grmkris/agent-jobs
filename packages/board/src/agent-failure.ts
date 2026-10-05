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
export function agentFailureReply(error: unknown, fallback: string, log: (errorId: string, error: unknown) => void = defaultLog, fallbackCode = 'unavailable'): AgentFailureReply {
  if (error instanceof BoardError) {
    const extra = error as unknown as { reason?: unknown; retry?: unknown; retryAfter?: unknown; errorId?: unknown }
    return {
      ok: false, code: error.code, message: error.message,
      ...(typeof extra.reason === 'string' ? { reason: extra.reason } : {}),
      ...(typeof extra.retry === 'string' && RETRIES.has(extra.retry) ? { retry: extra.retry as AgentRetry } : {}),
      ...(typeof extra.retryAfter === 'number' && Number.isFinite(extra.retryAfter) && extra.retryAfter > 0 ? { retryAfter: Math.ceil(extra.retryAfter) } : {}),
      ...(typeof extra.errorId === 'string' && /^[0-9a-f]{12}$/.test(extra.errorId) ? { errorId: extra.errorId } : {}),
    }
  }
  const revert = revertName(error)
  if (revert !== undefined) return { ok: false, code: 'chain', message: `The chain refused this call: ${revert}`, reason: 'revert', retry: 'none' }
  const errorId = Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => byte.toString(16).padStart(2, '0')).join('')
  log(errorId, error)
  return { ok: false, code: fallbackCode, message: `${fallback} (error ${errorId}); retry the same operationKey`, reason: 'internal', retry: 'same-key', errorId }
}

/**
 * Rebuilds a failure from a sanitized board reply (Board.call already applied agentFailureReply), keeping its code,
 * message and fields so the caller's own boundary passes them on instead of treating the reply as unexpected.
 */
export function failureFromReply(reply: { code: string; message: string; reason?: unknown; retry?: unknown; retryAfter?: unknown; errorId?: unknown }): BoardError {
  return Object.assign(new BoardError(reply.code as BoardError['code'], reply.message), { reason: reply.reason, retry: reply.retry, retryAfter: reply.retryAfter, errorId: reply.errorId })
}

/** A decoded custom-error name from a viem revert anywhere in the cause chain: contract ABI names only, never free text. */
function revertName(error: unknown): string | undefined {
  for (let current = error, depth = 0; typeof current === 'object' && current !== null && depth < 8; depth++) {
    const name = (current as { data?: { errorName?: unknown } }).data?.errorName
    if (typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) return name
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

function defaultLog(errorId: string, error: unknown): void {
  console.error(JSON.stringify({ event: 'agent-failure', errorId, ...errorDiagnostics(error) }))
}

/**
 * Static facts about an error for Worker logs: its class name, our short code and an HTTP status. Never its message,
 * cause or response body, which can carry RPC URLs, bearer tokens or provider credentials of any shape.
 */
export function errorDiagnostics(error: unknown): { name: string; code?: string; status?: number } {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { name?: unknown; code?: unknown; status?: unknown }
  return {
    name: typeof e.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.name) ? e.name : typeof error,
    ...(typeof e.code === 'string' && /^[a-z][a-z-]{0,31}$/.test(e.code) ? { code: e.code } : {}),
    ...(typeof e.status === 'number' && Number.isSafeInteger(e.status) ? { status: e.status } : {}),
  }
}
