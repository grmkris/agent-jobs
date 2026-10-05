/**
 * Deadlines for tool arguments: unix seconds, a duration from now (`30m`, `2h`, `3d`, `1w`) or an ISO-8601 date with
 * a zone. Resolution happens once, when the board prepares the call; a hosted retry replays the frozen preparation
 * and the REST idempotency key returns the first result, so a retry never moves the deadline.
 */
import { BoardError } from '@agent-jobs/board'

const UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 }
const MAX_RELATIVE_SECONDS = 366 * 86_400

export function resolveDeadline(value: unknown, field: string, now: number): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw new BoardError('invalid', `${field} must be unix seconds, a duration like "3d" or an ISO date`)
    return value
  }
  if (typeof value !== 'string') throw new BoardError('invalid', `${field} must be unix seconds, a duration like "3d" or an ISO date`)
  const text = value.trim()
  if (/^\d{1,12}$/.test(text)) return resolveDeadline(Number(text), field, now)
  const relative = /^(\d{1,6})\s*([smhdw])$/i.exec(text)
  if (relative !== null) {
    const seconds = Number(relative[1]) * UNIT_SECONDS[relative[2]!.toLowerCase()]!
    if (seconds <= 0 || seconds > MAX_RELATIVE_SECONDS) throw new BoardError('invalid', `${field} must be a duration between 1s and 366d`)
    return now + seconds
  }
  // A date without a zone would depend on the server's clock zone; require one (Z or ±hh:mm).
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    const ms = Date.parse(text)
    if (Number.isFinite(ms)) return Math.floor(ms / 1000)
  }
  throw new BoardError('invalid', `${field} must be unix seconds, a duration like "3d" or an ISO date with a zone`)
}

/** The deadline schema for tool inputs: a number keeps old clients valid, a string carries the new forms. */
export const deadlineSchema = (description: string) => ({
  type: ['number', 'string'],
  description: `${description} Unix seconds, a duration from now ("30m", "2h", "3d", "1w") or an ISO date with a zone; the result echoes the absolute time.`,
})

/**
 * Resolves the deadline fields present in tool arguments against one clock reading. When any was given as a duration
 * or a date, `echo` adds the absolute times to the result, so the caller sees what it agreed to.
 */
export function deadlineArgs(args: Record<string, unknown>, fields: readonly string[], now = Math.floor(Date.now() / 1000)) {
  const values: Record<string, number> = {}
  let relative = false
  for (const field of fields) {
    const value = args[field]
    if (value === undefined) continue
    values[field] = resolveDeadline(value, field, now)
    relative ||= typeof value === 'string' && !/^\d+$/.test(value.trim())
  }
  return {
    values,
    echo: <T>(result: T): T => relative && typeof result === 'object' && result !== null ? { ...result, deadlines: values } : result,
  }
}
