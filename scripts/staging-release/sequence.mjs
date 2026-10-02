import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import { nativeResource } from './live-plan.mjs'

/** Keep Alchemy's complete graph and lifecycle, gating each Worker reconcile on
 * its predecessor's successful readback. A failed step interrupts the graph.
 * `checks.before(id, input)` runs inside the reconcile, immediately before the
 * provider uploads; `checks.after(id, output)` right after it. */
export const sequenceWorkers = (snapshot, verify, record, checks = {}) => Effect.gen(function* () {
  const ready = {}
  for (const id of ['Api', 'Indexer', 'Explore']) ready[id] = yield* Deferred.make()
  for (const [id, predecessor] of [['Api', undefined], ['Indexer', 'Api'], ['Explore', 'Indexer']]) {
    const node = nativeResource(snapshot, id)
    if (node === undefined) return yield* Effect.fail(new Error(`Native plan resource missing: ${id}`))
    if (node.action === 'noop') {
      yield* Effect.promise(() => verify(id))
      yield* Deferred.succeed(ready[id], undefined)
      continue
    }
    const reconcile = node.provider.reconcile
    node.provider = { ...node.provider, reconcile: (input) => Effect.gen(function* () {
      if (predecessor) yield* Deferred.await(ready[predecessor])
      if (checks.before) yield* checks.before(id, input)
      record({ id, status: 'uploading' })
      const output = yield* reconcile(input)
      if (checks.after) yield* checks.after(id, output)
      let verified = false
      for (let attempt = 0; attempt < 12; attempt++) {
        const check = yield* Effect.promise(() => verify(id).then(() => true, () => false))
        if (check) { verified = true; break }
        yield* Effect.sleep('5 seconds')
      }
      if (!verified) return yield* Effect.fail(new Error(`Post-upload verification failed: ${id}`))
      record({ id, status: 'verified', hash: output.hash, at: new Date().toISOString() })
      yield* Deferred.succeed(ready[id], undefined)
      return output
    }) }
  }
})
