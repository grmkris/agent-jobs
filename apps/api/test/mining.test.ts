import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import { expect } from 'vitest'
import MiningDrill from './mining-worker.ts'

const { test, beforeAll, deploy } = Test.make({ providers: Cloudflare.providers(), state: Alchemy.localState(), dev: true })
const Stack = Alchemy.Stack('SidequestMiningLocalTest', { providers: Cloudflare.providers(), state: Alchemy.localState() }, Effect.gen(function* () {
  const worker = yield* MiningDrill
  return { url: worker.url }
}))
const stack = beforeAll(deploy(Stack))
test('real local workerd reads an epoch from its R2 binding and verifies the contracts-produced claim', Effect.gen(function* () {
  const { url } = yield* stack
  const response = yield* HttpClient.get(url as string)
  const result = (yield* response.json) as { runtime: string; amount: string; verified: boolean; missing: null }
  expect(result.runtime).toBe('Cloudflare-Workers')
  expect(result.amount).toBe('7')
  expect(result.verified).toBe(true)
  expect(result.missing).toBeNull()
}))
