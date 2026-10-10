import { Clock, Effect } from 'effect'

/** Public timestamps and feed occurredAt use Unix seconds, matching the existing Board and D1 feed. */
export const nowSeconds = Clock.currentTimeMillis.pipe(Effect.map((milliseconds) => Math.floor(milliseconds / 1000)))
