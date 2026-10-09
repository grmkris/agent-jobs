import { expect, it } from 'vitest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { agentManagement } from '../src/agent-management.ts'
import { avatarRouteRequest } from '../src/agent-profile-management.ts'
import { agentRoute } from '../src/routes/agents.ts'
import { profileReader, profilesResponse } from '../src/profiles.ts'
import { fixture as profileFixture, origin, operator, outsider, png } from './agent-profile-fixture.ts'

function fixture() {
  const f = profileFixture()
  const manage = (action: string, body: Record<string, unknown>, owner: `0x${string}` = operator, bytes?: Uint8Array) =>
    agentManagement({
      request: { action, id: 'one', body, ...(bytes === undefined ? {} : { avatarBytes: bytes }) },
      sql: f.sql,
      context: f.context,
      operator: owner,
      bindings: f.bindings,
      now: f.now,
      rpcUrl: '',
      relayKey: '0x',
      execute: async () => {
        throw new Error('unexpected execute')
      },
    })
  return { ...f, manage }
}

it('owner REST edits, raw uploads and generation return the public profile shape', async () => {
  const f = fixture()
  const text = await f.manage('profile', {
    name: 'Owner name',
    description: 'Owner description',
    tagline: 'Owner tagline',
    operationKey: 'owner-text',
  })
  expect(text).toMatchObject({
    name: 'Owner name',
    description: 'Owner description',
    tagline: 'Owner tagline',
    image: null,
  })
  const upload = await f.manage('avatar', { operationKey: 'owner-upload' }, operator, png)
  expect(upload).toMatchObject({ image: expect.stringContaining('/avatars/') })
  const generated = await f.manage('avatar-generate', { prompt: 'a fox', operationKey: 'owner-generate' })
  expect(generated).toMatchObject({ name: 'Owner name', image: expect.stringContaining('.png') })
  expect(f.boot().profiles.read('one')).toMatchObject({
    updatedBy: 'owner',
    avatarPrompt: expect.stringContaining('a fox'),
  })
  f.agents.bindRegistry('one', '2089')
  const response = await profilesResponse(
    profileReader(f.sql, () => 1_800_000_000, f.context.deployment),
    origin,
    '/data/profiles/2089',
  )
  const profileResponse = await HttpServerResponse.toWeb(response).json()
  expect(profileResponse).toMatchObject({
    ok: true,
  })
  expect(profileResponse).toHaveProperty('profiles.0.agentId', '2089')
  expect(profileResponse).toHaveProperty('profiles.0.name', 'Owner name')
  expect(profileResponse).toHaveProperty('profiles.0.description', 'Owner description')
})

it('refuses another operator before model calls, object writes or profile changes', async () => {
  const f = fixture()
  await expect(f.manage('profile', { name: 'Hijacked' }, outsider)).rejects.toThrow('another operator')
  await expect(f.manage('avatar-generate', { prompt: 'evil' }, outsider)).rejects.toThrow('another operator')
  await expect(f.manage('avatar', {}, outsider, png)).rejects.toThrow('another operator')
  expect(f.generations()).toBe(0)
  expect(f.files.size).toBe(0)
  expect(f.agents.get('one').name).toBe('Quill')
  await expect(f.manage('profile', { avatar: { generate: 'fox' } })).rejects.toMatchObject({ code: 'invalid' })
})

it('preserves owner generation provider failures instead of reporting invalid input', async () => {
  const f = fixture()
  f.fail(true)
  await expect(f.manage('avatar-generate', { prompt: 'fox', operationKey: 'provider-failure' })).rejects.toThrow(
    'provider unavailable',
  )
  expect(f.boot().profiles.read('one').generations).toBe(1)
})

it('routes owner profile writes and forwards raw bytes without trusting MIME', () => {
  expect(agentRoute('POST', '/api/agents/one/profile', {})).toMatchObject({ action: 'profile', id: 'one' })
  expect(agentRoute('POST', '/api/agents/one/avatar/generate', {})).toMatchObject({
    action: 'avatar-generate',
    id: 'one',
  })
  expect(agentRoute('GET', '/api/agents/one/avatar/generate', {})).toBeUndefined()
  expect(
    avatarRouteRequest({ method: 'POST', path: '/api/agents/one/avatar', contentType: 'image/jpeg', bytes: png }),
  ).toMatchObject({ action: 'avatar', avatarBytes: png })
  expect(() =>
    avatarRouteRequest({ method: 'POST', path: '/api/agents/one/avatar', contentType: 'text/plain', bytes: png }),
  ).toThrow()
})
