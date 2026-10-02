import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import { expect } from 'vitest'
import RecoveryDrill from './recovery-worker.ts'

const { test, beforeAll, deploy } = Test.make({ providers: Cloudflare.providers(), state: Alchemy.localState(), dev: true })
const Stack = Alchemy.Stack('E38LocalRecoveryDrill', { providers: Cloudflare.providers(), state: Alchemy.localState() }, Effect.gen(function* () {
  const worker = yield* RecoveryDrill
  return { url: worker.url }
}))
const stack = beforeAll(deploy(Stack))

test('disposable local workerd D1 restores and rebuilds real indexed chain facts without deleting hosted rows', Effect.gen(function* () {
  const { url } = yield* stack
  const response = yield* HttpClient.get(url as string)
  const result = (yield* response.json) as { ok: boolean; runtime: string; events: number; protocolEvents: number; jobs: number; restored: boolean; rebuilt: boolean; hostedRowsRetained: boolean }
  expect(result.runtime).toBe('Cloudflare-Workers')
  expect(result.ok).toBe(true)
  expect(result.events).toBe(185)
  expect(result.protocolEvents).toBe(23)
  expect(result.jobs).toBe(14)
  expect(result.restored && result.rebuilt && result.hostedRowsRetained).toBe(true)
}))
