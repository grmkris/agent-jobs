import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'

/**
 * One Durable Object per hosted board (spec §5). S0 proves the DO round-trips SQLite-backed
 * storage under alchemy's local workerd; B2 ports the Dispatch state machine into it.
 */
export default class Board extends Cloudflare.DurableObject<Board>()(
  'Board',
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState

    return Effect.gen(function* () {
      const stored = (yield* state.storage.get<number>('tasks')) ?? 0

      return {
        /** Records one more task on this board and returns the new count. */
        createTask: () =>
          Effect.gen(function* () {
            const current = (yield* state.storage.get<number>('tasks')) ?? stored
            const next = current + 1
            yield* state.storage.put('tasks', next)
            return next
          }),
        /** The number of tasks recorded on this board. */
        taskCount: () =>
          Effect.gen(function* () {
            return (yield* state.storage.get<number>('tasks')) ?? 0
          }),
      }
    })
  }),
) {}
