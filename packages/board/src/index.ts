/**
 * The board state machine. Ported from Cloudflare OS's Dispatch `board-logic` in B2; for S0 this
 * only pins the shape of the pure core: every transition is a function over stored state and a
 * clock, with no I/O, so the whole lifecycle is testable in Node.
 */

/** The lifecycle of one task on a hosted board (spec §5). */
export type TaskStatus =
  | 'available'
  | 'reserved'
  | 'assigned'
  | 'accepted'
  | 'funded'
  | 'drafts'
  | 'finalized'
  | 'decided'
  | 'disputed'
  | 'settled'

/** Transitions a worker or publisher may request off-chain. On-chain facts are mirrored, not decided, here. */
export const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  available: ['reserved'],
  reserved: ['available', 'assigned'],
  assigned: ['accepted'],
  accepted: ['funded'],
  funded: ['drafts', 'finalized'],
  drafts: ['drafts', 'finalized'],
  finalized: ['decided', 'disputed'],
  decided: ['settled'],
  disputed: ['settled'],
  settled: [],
}

/**
 * @param from The current status.
 * @param to The requested status.
 * @returns Whether the board may move the task from `from` to `to`.
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

/**
 * `release_job` is valid only before the on-chain assignment boundary (spec §5): once a provider
 * is set in the core, the board reflects chain state and cannot make the task look available.
 * @param status The task's current status.
 */
export function canRelease(status: TaskStatus): boolean {
  return status === 'reserved'
}
