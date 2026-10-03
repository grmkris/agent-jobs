import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import * as HttpBody from 'effect/unstable/http/HttpBody'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import { WRITE_LIMITS } from '@agent-jobs/board'
import { afterAll, beforeAll as hookBeforeAll, expect } from 'vitest'
import * as sdk from '@agent-jobs/sdk'
import { zeroAddress, type Hex } from 'viem'
import { forkEnabled, startHirelingFork } from '../../../packages/sdk/test/hireling-fixture.ts'
import { directoryObjectName } from '../src/directory-object.ts'
import DirectoryMainnetProbe from './directory-worker.ts'
import DirectoryDrainedProbe from './directory-drained-worker.ts'
import DirectoryTestnetProbe from './directory-testnet-worker.ts'
import type { DirectoryCall } from '../src/directory-object.ts'

const { test, beforeAll, deploy } = Test.make({ providers: Cloudflare.providers(), state: Alchemy.localState(), dev: true })
const Stack = Alchemy.Stack('HirelingDirectoryLocalDrill', { providers: Cloudflare.providers(), state: Alchemy.localState() }, Effect.gen(function* () {
  const open = yield* DirectoryMainnetProbe, drained = yield* DirectoryDrainedProbe, testnet = yield* DirectoryTestnetProbe
  return { open: open.url!, drained: drained.url!, testnet: testnet.url! }
}))
const stack = beforeAll(deploy(Stack))
const post = (url: string | undefined, body: unknown) => Effect.gen(function* () {
  const response = yield* HttpClient.post(url as string, { body: HttpBody.text(JSON.stringify(body), 'application/json') })
  return (yield* response.json) as { ok: boolean; code?: string; message?: string; retryAfter?: number; result?: unknown }
})
const request = (patch: Partial<DirectoryCall> = {}): DirectoryCall => ({ network: 'monad-mainnet', rpcUrl: '', audience: 'https://test.invalid', agentId: '7', action: 'prepare', kind: 'Enrollment', payload: {}, ...patch })

test('real directory RPC refuses missing/forged sessions, IPs, runtime networks and drained writes before service construction', Effect.gen(function* () {
  const urls = yield* stack
  const wallet = '0x1111111111111111111111111111111111111111', token = crypto.randomUUID()
  const auth = { boardId: 'public', bearer: token, caller: wallet, ip: '203.0.113.71' }
  for (const call of [request(), request({ admission: { ...auth, bearer: undefined } }), request({ admission: { ...auth, caller: '0x2222222222222222222222222222222222222222' } }), request({ admission: { ...auth, ip: undefined } }), request({ network: 'monad-testnet', admission: auth })]) {
    expect(yield* post(urls.open, { name: 'denied', call, seed: { token, wallet } })).toMatchObject({ ok: false, code: 'forbidden' })
  }
  expect(yield* post(urls.drained, { name: 'denied', call: request({ admission: auth }), seed: { token, wallet } })).toMatchObject({ ok: false, code: 'forbidden' })
}))

test('directory submits cannot bypass the real shared wallet counter with a forged read label', Effect.gen(function* () {
  const { open } = yield* stack
  const wallet = `0x${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().slice(0, 8)}`, token = crypto.randomUUID()
  const prefix = `2001:db8:${crypto.randomUUID().slice(0, 4)}:${crypto.randomUUID().slice(0, 4)}`
  const auth = { boardId: 'public', bearer: token, caller: wallet, ip: `${prefix}::1` }
  for (let n = 0; n < WRITE_LIMITS.wallet; n++) {
    expect(yield* post(open, { admit: { ...auth, network: 'monad-mainnet', tool: 'create_task', ip: `${prefix}::${n + 10}` }, seed: { token, wallet } })).toEqual({ ok: true })
  }
  const forgedAuth = { ...auth, tool: 'list_directory', network: 'monad-testnet' }
  const call = request({ action: 'submit', record: { kind: 'Enrollment' }, admission: forgedAuth })
  expect(yield* post(open, { name: 'rate-denied', call })).toMatchObject({ ok: false, code: 'rate-limited', retryAfter: expect.any(Number) })
}))

test('direct directory RPC canonicalizes host origins and refuses alternate objects and signed audiences', Effect.gen(function* () {
  const { testnet } = yield* stack
  const config = sdk.deployment('monad-testnet')
  const audience = `https://${crypto.randomUUID()}.test.invalid`
  const rawAudience = `${audience.toUpperCase()}:443`
  const name = directoryObjectName(config.chainId, config.identity, audience, '7')
  const call = request({ network: 'monad-testnet', audience: rawAudience, action: 'read' })
  expect(yield* post(testnet, { name, call })).toMatchObject({ ok: true, result: { agentId: '7', revision: 0 } })
  // A second spelling must use the same stored scope; storing the raw first value would refuse this read.
  expect(yield* post(testnet, { name, call: { ...call, audience } })).toMatchObject({ ok: true, result: { agentId: '7', revision: 0 } })
  const rawName = `${config.chainId}:${config.identity.toLowerCase()}:${rawAudience}:7`
  expect(yield* post(testnet, { name: rawName, call })).toMatchObject({ ok: false, code: 'forbidden', message: 'directory object identity mismatch' })
  for (const invalid of ['ftp://test.invalid', 'blob:https://test.invalid/id', 'not a URL']) {
    expect(yield* post(testnet, { name, call: { ...call, audience: invalid } })).toMatchObject({ ok: false, code: 'invalid', message: 'directory audience must be an HTTP(S) origin' })
  }
  const now = Math.floor(Date.now() / 1000)
  const record: sdk.DirectoryEnvelope = {
    version: 1, kind: 'Enrollment', chainId: config.chainId, identityRegistry: config.identity,
    audience: rawAudience, agentId: '7', wallet: zeroAddress, generation: 1, nonce: 1, issuedAt: now, expiresAt: now + 300,
    payload: { profile: { name: 'Origin probe', description: '', services: [] }, enrolled: true, delegate: zeroAddress, adDelegate: false, grantExpiresAt: 0 },
  }
  expect(yield* post(testnet, { name, call: { ...call, action: 'submit', record, signature: '0x00' } })).toMatchObject({ ok: false, code: 'forbidden', message: 'wrong chain, registry, audience, or agent' })
}))

let fork: Awaited<ReturnType<typeof startHirelingFork>> | undefined
hookBeforeAll(async () => { if (forkEnabled) fork = await startHirelingFork() }, 180_000)
afterAll(() => fork?.close())

test.skipIf(!forkEnabled)('real directory object verifies the registry wallet and signature, replays enrollment once, and rejects aliased owners', Effect.gen(function* () {
  const { testnet } = yield* stack
  const f = fork!
  const agentId = (yield* Effect.promise(() => sdk.registerAgent(f.ctx, f.worker, 'https://hireling.xyz/directory-fork'))).toString()
  const audience = `https://${crypto.randomUUID()}.test.invalid`
  const name = directoryObjectName(10143, f.ctx.deployment.identity, audience, agentId)
  const call = request({ network: 'monad-testnet', agentId, audience, rpcUrl: f.url, payload: { profile: { name: 'Local fork worker', description: '', services: ['Research'] }, enrolled: true, delegate: zeroAddress, adDelegate: false, grantExpiresAt: 0 } })
  expect(yield* post(testnet, { name: `alias-${name}`, call })).toMatchObject({ ok: false, code: 'forbidden', message: 'directory object identity mismatch' })
  const prepared = yield* post(testnet, { name, call })
  expect(prepared.ok).toBe(true)
  const record = prepared.result as sdk.DirectoryEnvelope
  expect(record.wallet).toBe(f.worker.account.address)
  const badSignature = yield* Effect.promise(() => f.creator.signTypedData(sdk.directoryTypedData(record)))
  expect(yield* post(testnet, { name, call: { ...call, action: 'submit', record, signature: badSignature } })).toMatchObject({ ok: false, code: 'forbidden', message: 'invalid directory signature' })
  expect((yield* post(testnet, { name, call: { ...call, action: 'read' } })).result).toMatchObject({ enrolled: false, revision: 0 })
  const signature = yield* Effect.promise(() => f.worker.signTypedData(sdk.directoryTypedData(record)))
  const submitted = { ...call, action: 'submit', record, signature: signature as Hex }
  expect((yield* post(testnet, { name, call: submitted })).result).toMatchObject({ idempotent: false, agent: { enrolled: true, wallet: f.worker.account.address, revision: 1 } })
  expect((yield* post(testnet, { name, call: submitted })).result).toMatchObject({ idempotent: true, agent: { enrolled: true, revision: 1 } })
  expect(yield* post(testnet, { name, call: { ...call, audience: 'https://evil.invalid' } })).toMatchObject({ ok: false, code: 'forbidden', message: 'directory object identity mismatch' })
  expect((yield* post(testnet, { name, call: { ...call, action: 'read' } })).result).toMatchObject({ enrolled: true, revision: 1 })
  const optOut = (yield* post(testnet, { name, call: { ...call, payload: { ...call.payload as Record<string, unknown>, enrolled: false } } })).result as sdk.DirectoryEnvelope
  const revoke = yield* Effect.promise(() => f.worker.signTypedData(sdk.directoryTypedData(optOut)))
  expect((yield* post(testnet, { name, call: { ...call, action: 'submit', record: optOut, signature: revoke } })).result).toMatchObject({ agent: { enrolled: false, revision: 2 } })
  expect((yield* post(testnet, { name, call: { ...call, action: 'read' } })).result).toMatchObject({ enrolled: false, revision: 2 })
}), { timeout: 180_000 })
