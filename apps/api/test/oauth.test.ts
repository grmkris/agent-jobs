/** Real SQLite storage and WebCrypto PKCE. No provider/network substitutions. */
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { AgentStore, fromNodeSqlite } from '@agent-jobs/board'
import type { Address } from 'viem'
import { oauthRoute, resolveOAuth, type OAuthReply } from '../src/oauth.ts'
import { pkceChallenge } from '../src/oauth-validation.ts'

const owner = `0x${'11'.repeat(20)}` as Address
const wallet = `0x${'22'.repeat(20)}` as Address
const registry = `0x${'33'.repeat(20)}` as Address
const origin = 'https://hireling.example'
const resource = `${origin}/b/team-board/mcp`
const verifier = 'a'.repeat(43)
const redirectUri = 'http://127.0.0.1:3210/callback'

type Tokens = { access_token: string; refresh_token: string }

function fixture() {
  const db = new DatabaseSync(':memory:')
  const sql = fromNodeSqlite(db)
  const agents = new AgentStore(sql, () => 1000)
  agents.create({ id: 'one', operator: owner, privyUserId: 'did:privy:test', name: 'one', registry, chainId: 10143 })
  agents.bindWallet('one', 'wallet-one', wallet)
  agents.bindRegistry('one', '10')
  for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const) agents.advance('one', state)
  const route = (path: string, body: Record<string, unknown> = {}, query = new URLSearchParams(), method = 'POST', operator: string | undefined = owner) => oauthRoute({ sql, path, body, query, method, origin, siteOrigin: origin, now: 1000, ...(operator === undefined ? {} : { owner: operator }) }) as Promise<OAuthReply>
  return { db, sql, agents, route }
}

async function connection(f: ReturnType<typeof fixture>) {
  const registered = await f.route('/oauth/register', { redirect_uris: [redirectUri], client_name: 'SQLite client' })
  const clientId = (registered.body as { client_id: string }).client_id
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'hireling:read hireling:work hireling:hire', resource, code_challenge_method: 'S256', code_challenge: await pkceChallenge(verifier), state: 'state-one' })
  const authorize = await f.route('/oauth/authorize', {}, query, 'GET')
  const requestId = new URL(authorize.redirect!).searchParams.get('oauth_request')!
  const approve = await f.route(`/oauth/requests/${requestId}/approve`, { agentIds: ['one'] })
  const code = new URL((approve.body as { result: { redirectUrl: string } }).result.redirectUrl).searchParams.get('code')!
  const tokenBody = { grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, resource, code, code_verifier: verifier }
  return { clientId, tokenBody, requestId, query }
}

test('one-agent OAuth code is bound to PKCE, client, redirect and exact tenant resource', async () => {
  const f = fixture()
  try {
    const c = await connection(f)
    for (const change of [{ resource: `${origin}/mcp` }, { client_id: 'other' }, { redirect_uri: 'http://127.0.0.1:3211/callback' }, { code_verifier: 'b'.repeat(43) }]) expect((await f.route('/oauth/token', { ...c.tokenBody, ...change })).status).toBe(400)
    const reply = await f.route('/oauth/token', c.tokenBody)
    expect(reply.status).toBe(200)
    const tokens = reply.body as Tokens
    expect((await resolveOAuth(f.sql, tokens.access_token, resource, 1000))?.agentIds).toEqual(['one'])
    expect(await resolveOAuth(f.sql, tokens.access_token, `${origin}/mcp`, 1000)).toBeUndefined()
    expect((await f.route('/oauth/token', c.tokenBody)).status).toBe(400)
    expect((await f.route(`/oauth/requests/${c.requestId}/approve`, { agentIds: ['one'] })).status).toBe(400)
  } finally { f.db.close() }
})

test('refresh rotates; replay revokes every token in the connection, including the rotated token', async () => {
  const f = fixture()
  try {
    const c = await connection(f)
    const first = (await f.route('/oauth/token', c.tokenBody)).body as Tokens
    const input = { grant_type: 'refresh_token', client_id: c.clientId, resource, refresh_token: first.refresh_token }
    const second = (await f.route('/oauth/token', input)).body as Tokens
    expect(await resolveOAuth(f.sql, second.access_token, resource, 1000)).toBeDefined()
    expect((await f.route('/oauth/token', input)).status).toBe(400)
    expect(await resolveOAuth(f.sql, second.access_token, resource, 1000)).toBeUndefined()
    expect(await resolveOAuth(f.sql, first.access_token, resource, 1000)).toBeUndefined()
  } finally { f.db.close() }
})

test('revoked agents cannot use or refresh an OAuth token and consent cannot grant several agents', async () => {
  const f = fixture()
  try {
    const c = await connection(f)
    const tokens = (await f.route('/oauth/token', c.tokenBody)).body as Tokens
    f.agents.advance('one', 'revoked')
    expect(await resolveOAuth(f.sql, tokens.access_token, resource, 1000)).toBeUndefined()
    expect((await f.route('/oauth/token', { grant_type: 'refresh_token', client_id: c.clientId, resource, refresh_token: tokens.refresh_token })).status).toBe(400)
  } finally { f.db.close() }
})
