import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import * as HttpClient from 'effect/http/HttpClient'
import { expect } from 'vitest'
import TelegramDrill from './telegram-worker.ts'

const { test, beforeAll, deploy } = Test.make({ providers: Cloudflare.providers(), state: Alchemy.localState(), dev: true })
const Stack = Alchemy.Stack('SidequestTelegramLocalTest', { providers: Cloudflare.providers(), state: Alchemy.localState() }, Effect.gen(function* () {
  const worker = yield* TelegramDrill
  return { url: worker.url }
}))
const stack = beforeAll(deploy(Stack))
test('real local workerd D1 verifies a signature, consumes the webhook once and claims concurrent sends once', Effect.gen(function* () {
  const { url } = yield* stack
  const response = yield* HttpClient.get(url as string)
  const result = (yield* response.json) as { runtime: string; linked: boolean; duplicate: boolean; queued: number; sent: number; counted: number; receipts: Array<{ status: string; telegram_message_id: number }>; delivered: number }
  expect(result.runtime).toBe('Cloudflare-Workers')
  expect(result.delivered).toBe(9)
  expect(result.linked).toBe(true)
  expect(result.duplicate).toBe(false)
  expect(result.queued).toBe(1)
  expect(result.sent).toBe(2)
  expect(result.counted).toBe(2)
  expect(result.receipts.every(r => r.status === 'sent' && r.telegram_message_id > 0)).toBe(true)
}))
