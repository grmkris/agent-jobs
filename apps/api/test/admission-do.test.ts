import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import * as HttpBody from 'effect/unstable/http/HttpBody'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import { expect } from 'vitest'
import AdmissionProbe from './admission-worker.ts'

const { test, beforeAll, deploy } = Test.make({ providers: Cloudflare.providers(), state: Alchemy.localState(), dev: true })
const Stack = Alchemy.Stack('E38LocalAdmissionProbe', { providers: Cloudflare.providers(), state: Alchemy.localState() }, Effect.gen(function* () {
  const worker = yield* AdmissionProbe
  return { url: worker.url }
}))
const stack = beforeAll(deploy(Stack))

test('real local Durable Object rejects forged caller, board, network, and policy before service construction', Effect.gen(function* () {
  const { url } = yield* stack
  const env = { network: 'monad-mainnet', boardId: 'public', rpcUrl: '', domain: 'test.invalid', uri: 'https://test.invalid', manifestBaseUrl: '', screening: { baseUrl: '', apiKey: '', model: '' }, attesterKey: '', relayKey: '', github: { appId: '', privateKeyPem: '', installationId: '' } }
  const attempts = [
    { tool: 'create_task', args: {}, env },
    { tool: 'create_task', args: { caller: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, caller: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', env },
    { tool: 'create_pool', args: {}, env: { ...env, admission: { enabled: false } } },
    { tool: 'create_task', args: {}, env: { ...env, boardId: 'other' } },
    { tool: 'create_task', args: {}, env: { ...env, network: 'monad-testnet' } },
    { tool: 'upgrade_account', args: {}, env },
  ]
  for (const [index, call] of attempts.entries()) {
    const response = yield* HttpClient.post(url as string, { body: HttpBody.text(JSON.stringify({ name: 'public', call }), 'application/json') })
    const result = (yield* response.json) as { ok: boolean; code: string; message: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('forbidden')
    expect(result.message).not.toContain('no deployment')
    if (index === 0) expect(result.message).toContain('approved wallet')
    if (index === 1) expect(result.message).toContain('authenticated session wallet')
    if (index === 3) expect(result.message).toContain('board identity mismatch')
    if (index === 4) expect(result.message).toContain('runtime network/stage mismatch')
  }
}))
