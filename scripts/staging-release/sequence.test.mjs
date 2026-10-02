import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import { nativeResource } from './live-plan.mjs'
import { sequenceWorkers } from './sequence.mjs'

function fixture(events, failAt) {
  return { native: { resources: Object.fromEntries(['Api', 'Indexer', 'Explore'].map((id) => [`AgentJobs/${id}`, {
    resource: { LogicalId: id },
    action: 'update', provider: { reconcile: () => Effect.gen(function* () {
      events.push(`upload:${id}`)
      if (failAt === id) return yield* Effect.fail(new Error('test upload failure'))
      return { hash: { bundle: id } }
    }) },
  }])) } }
}

test('concurrent Alchemy reconciles wait for API, then Indexer, then Explore readback', async () => {
  const events = []
  const snapshot = fixture(events)
  await Effect.runPromise(Effect.gen(function* () {
    yield* sequenceWorkers(snapshot, async (id) => { events.push(`verify:${id}`) }, () => {})
    yield* Effect.all(['Explore', 'Indexer', 'Api'].map((id) => nativeResource(snapshot, id).provider.reconcile()), { concurrency: 'unbounded' })
  }))
  assert.deepEqual(events, ['upload:Api', 'verify:Api', 'upload:Indexer', 'verify:Indexer', 'upload:Explore', 'verify:Explore'])
})

test('a failed API upload prevents both downstream uploads', async () => {
  const events = []
  const snapshot = fixture(events, 'Api')
  await assert.rejects(Effect.runPromise(Effect.gen(function* () {
    yield* sequenceWorkers(snapshot, async (id) => { events.push(`verify:${id}`) }, () => {})
    yield* Effect.all(['Explore', 'Indexer', 'Api'].map((id) => nativeResource(snapshot, id).provider.reconcile()), { concurrency: 'unbounded' })
  })))
  assert.deepEqual(events, ['upload:Api'])
})
