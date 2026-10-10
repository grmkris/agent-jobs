import { Clock, Effect, Ref } from 'effect'
import { Caches, StakeReader } from '../services.ts'
import { Unavailable } from '../errors.ts'

export const roadmapWeights = Effect.fnUntraced(function* (addresses: readonly string[]) {
  const voters = [...new Set(addresses)].toSorted()
  const key = JSON.stringify(voters)
  const caches = yield* Caches
  const now = yield* Clock.currentTimeMillis
  const cached = (yield* Ref.get(caches.weights)).get(key)
  if (cached !== undefined && cached.expiresAt > now) return cached.value
  const snapshot = yield* (yield* StakeReader).stakes(voters)
  if (voters.some((voter) => !snapshot.stake.has(voter)))
    return yield* new Unavailable({ message: 'Stake reader omitted roadmap voters' })
  yield* Ref.update(caches.weights, (map) =>
    new Map([...map].filter(([, value]) => value.expiresAt > now)).set(key, {
      expiresAt: now + 30_000,
      value: snapshot,
    }),
  )
  return snapshot
})
