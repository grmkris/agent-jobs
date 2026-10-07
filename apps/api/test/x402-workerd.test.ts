import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import * as HttpClient from 'effect/http/HttpClient'
import { expect } from 'vitest'
import X402Drill from './x402-worker.ts'

const { test, beforeAll, deploy } = Test.make({ providers: Cloudflare.providers(), state: Alchemy.localState(), dev: true })
const Stack = Alchemy.Stack('SidequestX402LocalTest', { providers: Cloudflare.providers(), state: Alchemy.localState() }, Effect.gen(function* () {
  const worker = yield* X402Drill
  return { url: worker.url }
}))
const stack = beforeAll(deploy(Stack))
test('real local workerd pays the x402 demo through verify and settle (VV2-031)', Effect.gen(function* () {
  const { url } = yield* stack
  const response = yield* HttpClient.get(url as string)
  const result = (yield* response.json) as { runtime: string; unpaid: number; paid: number; transaction: string; requests: Array<{ path: string; redirect: string }> }
  expect(result.runtime).toBe('Cloudflare-Workers')
  expect(result.unpaid).toBe(402)
  expect(result.paid).toBe(200)
  expect(result.transaction).toBe(`0x${'ab'.repeat(32)}`)
  expect(result.requests.map(r => r.path)).toEqual(['/verify', '/settle'])
  expect(result.requests.every(r => r.redirect === 'manual')).toBe(true)
}))
