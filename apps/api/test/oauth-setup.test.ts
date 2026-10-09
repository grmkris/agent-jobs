import { afterEach, expect, it } from 'vitest'
import { resolveOAuth, OAUTH_SCOPES } from '../src/oauth.ts'
import { setupFixture, operator, resource, origin } from './setup-oauth-fixture.ts'

const fixtures: ReturnType<typeof setupFixture>[] = []
const fixture = () => {
  const f = setupFixture()
  fixtures.push(f)
  return f
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.db.close()
})

it('advertises setup and approves an agentless resource-bound grant with setup authority only', async () => {
  const f = fixture()
  expect(OAUTH_SCOPES).toContain('sidequest:setup')
  const c = await f.connection()
  expect(c.tokens.scope).toBe('sidequest:setup')
  expect(await resolveOAuth(f.sql, c.tokens.access_token, resource, 1000)).toMatchObject({
    setup: true,
    owner: operator.toLowerCase(),
    scopes: ['sidequest:setup'],
    agentIds: [],
    registryAgentId: null,
  })
  expect(await resolveOAuth(f.sql, c.tokens.access_token, `${origin}/mcp`, 1000)).toBeUndefined()
  expect(f.agents.list(operator)).toEqual([])
})

it('consent data offers setup and declines selecting an agent or widening future scopes', async () => {
  const f = fixture(),
    r = await f.request()
  expect((await f.route(`/oauth/requests/${r.requestId}`, {}, undefined, 'GET'))?.body).toMatchObject({
    result: { agents: [], setup: { available: true, scope: 'sidequest:setup' } },
  })
  for (const body of [
    { setup: true, agentIds: ['quill'] },
    { setup: true, scopes: ['sidequest:setup', 'sidequest:hire'] },
    { setup: true, scopes: ['sidequest:work'] },
  ])
    expect((await f.route(`/oauth/requests/${r.requestId}/approve`, body))?.status).toBe(400)
  expect(
    (await f.route(`/oauth/requests/${r.requestId}/approve`, { setup: true }, undefined, 'POST', null))?.status,
  ).toBe(401)
})

it('rejects setup approval unless the client explicitly requested it', async () => {
  const f = fixture(),
    r = await f.request('sidequest:read')
  expect((await f.route(`/oauth/requests/${r.requestId}/approve`, { setup: true }))?.status).toBe(400)
})

it('binds setup codes to PKCE, client, redirect and resource and consumes them once', async () => {
  const f = fixture(),
    c = await f.connection()
  expect((await f.route('/oauth/token', c.tokenBody))?.status).toBe(400)
  const next = await f.request()
  const approved = await f.route(`/oauth/requests/${next.requestId}/approve`, { setup: true })
  expect(approved?.status).toBe(200)
  // The already-issued grant remains usable while wrong exchange attempts are rejected.
  for (const change of [
    { client_id: 'other' },
    { resource: `${origin}/mcp` },
    { redirect_uri: 'https://other.example/cb' },
    { code_verifier: 'b'.repeat(43) },
  ])
    expect((await f.route('/oauth/token', { ...c.tokenBody, ...change }))?.status).toBe(400)
  expect(await resolveOAuth(f.sql, c.tokens.access_token, resource, 1000)).toBeDefined()
})

it('rotates refresh tokens and revokes the whole setup family on replay or explicit disconnect', async () => {
  const f = fixture(),
    c = await f.connection()
  const body = { grant_type: 'refresh_token', client_id: c.clientId, resource, refresh_token: c.tokens.refresh_token }
  expect((await f.route('/oauth/token', { ...body, resource: `${origin}/mcp` }))?.status).toBe(400)
  expect((await f.route('/oauth/token', body))?.status).toBe(200)
  expect((await f.route('/oauth/token', body))?.status).toBe(400)
  expect(await resolveOAuth(f.sql, c.tokens.access_token, resource, 1000)).toBeUndefined()
  const other = await f.connection()
  await f.route('/oauth/revoke', { token: other.tokens.access_token, client_id: other.clientId })
  expect(await resolveOAuth(f.sql, other.tokens.access_token, resource, 1000)).toBeUndefined()
})

it('keeps agent-family authority isolated from setup and rejects expired setup tokens', async () => {
  const f = fixture(),
    c = await f.connection()
  f.clock(4600)
  expect(await resolveOAuth(f.sql, c.tokens.access_token, resource, f.now())).toBeUndefined()
  expect(f.sql.all('SELECT * FROM agent_oauth_families')).toEqual([])
})
