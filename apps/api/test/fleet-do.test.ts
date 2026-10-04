import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import * as HttpBody from 'effect/unstable/http/HttpBody'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import { generateKeyPairSync, sign } from 'node:crypto'
import { expect } from 'vitest'
import FleetProbe from './fleet-worker.ts'

const { test, beforeAll, deploy } = Test.make({ providers: Cloudflare.providers(), state: Alchemy.localState(), dev: true })
const Stack = Alchemy.Stack('HirelingFleetLocalDrill', { providers: Cloudflare.providers(), state: Alchemy.localState() }, Effect.gen(function* () {
  const worker = yield* FleetProbe
  return { url: worker.url! }
}))
const stack = beforeAll(deploy(Stack))
const post = (url: string | undefined, body: unknown) => Effect.gen(function* () {
  const response = yield* HttpClient.post(url as string, { body: HttpBody.text(JSON.stringify(body), 'application/json') })
  return { status: response.status, body: (yield* response.json) as { ok: boolean; result: any; code?: string } }
})

test('real workerd persists pairing and verifies one-use signed health and revocation generations', Effect.gen(function* () {
  const { url } = yield* stack
  const owner = `0x${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().slice(0, 8)}`
  const seeded = yield* post(url, { path: '/seed', method: 'POST', body: {}, owner })
  const id = seeded.body.result.agent.id as string
  const pair = yield* post(url, { path: `/api/agents/${id}/pair`, method: 'POST', body: {}, owner })
  const code = pair.body.result.code as string
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicKeySpki = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const signature = sign('sha256', Buffer.from(`hireling-pair-v1\n${code}\n${publicKeySpki}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64')
  const complete = { path: '/api/pairings/complete', method: 'POST', body: { code, publicKeySpki, signature } }
  const paired = yield* post(url, complete)
  expect(paired.status).toBe(200)
  expect(paired.body.result.gatewayEnabled).toBe(false)
  expect((yield* post(url, complete)).status).toBe(403)
  const bearer = paired.body.result.runtimeToken as string
  for (const status of ['launched', 'ready', 'healthy']) {
    const challenge = yield* post(url, { path: `/api/agents/${id}/health`, method: 'GET', body: {}, bearer })
    const launchId = 'workerd-real-process-metadata', firstPromptHash = 'a'.repeat(64), pid = 12345
    const healthSignature = sign('sha256', Buffer.from(`hireling-health-v2\n${id}\n0\n${challenge.body.result.challenge}\n${status}\n0.1.0\n${launchId}\n${firstPromptHash}\n${pid}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64')
    const health = { path: `/api/agents/${id}/health`, method: 'POST', bearer, body: { challenge: challenge.body.result.challenge, signature: healthSignature, generation: 0, status, version: '0.1.0', launchId, firstPromptHash, pid } }
    expect((yield* post(url, health)).status).toBe(200)
    expect((yield* post(url, health)).status).toBe(403)
  }
  const listing = yield* post(url, { path: '/api/agents', method: 'GET', body: {}, owner })
  expect(listing.body.result.agents.find((agent: { id: string }) => agent.id === id)).toMatchObject({ status: 'healthy', companionVersion: '0.1.0' })
  const stranger = yield* post(url, { path: `/api/agents/${id}`, method: 'GET', body: {}, owner: '0x2222222222222222222222222222222222222222' })
  expect(stranger.status).toBe(404)
  expect((yield* post(url, { path: `/api/agents/${id}/revoke`, method: 'POST', body: {}, owner })).status).toBe(200)
  expect((yield* post(url, { path: `/api/agents/${id}/health`, method: 'GET', body: {}, bearer })).status).toBe(401)
  const revoked = yield* post(url, { path: `/api/agents/${id}`, method: 'GET', body: {}, owner })
  expect(revoked.body.result.agent).toMatchObject({ status: 'stopped', generation: 1 })
}))
