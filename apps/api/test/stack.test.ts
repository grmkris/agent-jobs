import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import * as HttpBody from 'effect/unstable/http/HttpBody'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import { expect } from 'vitest'
import Stack from '../../../alchemy.run.ts'
import { decodeX402Header } from '@sidequest/board'
import { deployment } from '@sidequest/sdk'

/**
 * Deploys the stack into local workerd (`dev: true`) and probes every binding through the Worker.
 * Runs without Cloudflare credentials: every resource here has a local provider.
 */
const { test, beforeAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  dev: true,
})

const stack = beforeAll(deploy(Stack))
// No `destroy`: the stack is local (`.alchemy/` is gitignored, CI runners are ephemeral) and
// destroying a local stack hangs the harness in alchemy 2.0.0-beta.79. Persisting it also makes
// reruns fast, so every test below must be independent of what earlier runs left behind.

const rpcSet = (process.env.MONAD_TESTNET_RPC_URL ?? '') !== ''

const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  HttpClient.post(url, { body: HttpBody.text(JSON.stringify(body), 'application/json'), headers })

test('the real local Worker serves the testnet x402 proof challenge without calling the facilitator',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const response = yield* HttpClient.get(`${apiUrl}/x402/demo`)
    expect(response.status).toBe(402)
    const header = response.headers['payment-required']
    expect(header).toBeDefined()
    const required = decodeX402Header(header!)
    expect(yield* response.json).toEqual(required)
    expect(required).toMatchObject({ x402Version: 2, accepts: [{ amount: '10000', payTo: deployment('monad-testnet').sidequest!.safe, network: 'eip155:10143' }] })
  }))

test('the worker answers from workerd',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const response = yield* HttpClient.get(`${apiUrl}/health`)
    const body = (yield* response.json) as { ok: boolean; runtime: string; network: string }
    expect(body.ok).toBe(true)
    // The same probe cloudflare-os uses: workerd hardcodes this user agent, Node never does.
    expect(body.runtime).toBe('Cloudflare-Workers')
    expect(body.network).toBe('monad-testnet')
  }))

test('there is no unauthenticated manifest write (the S0 PUT is gone)',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const put = yield* HttpClient.put(`${apiUrl}/manifests/x.json`, { body: HttpBody.text('{}') })
    expect(put.status).toBe(404)
    const get = yield* HttpClient.get(`${apiUrl}/offers/0x${'00'.repeat(32)}.json`)
    expect(get.status).toBe(404)
  }))

test('directory discovery and its Durable Object work without a job or wallet transaction',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const response = yield* HttpClient.get(`${apiUrl}/data/directory`)
    expect(response.status).toBe(200)
    const page = (yield* response.json) as { ok: boolean; agents: unknown[]; nextCursor: string | null }
    expect(page.ok).toBe(true)
    expect(page.agents).toEqual([])
    expect(page.nextCursor).toBeNull()
    const missing = yield* HttpClient.get(`${apiUrl}/data/directory/7001`)
    expect(missing.status).toBe(404)
    const read = yield* postJson(`${apiUrl}/api/list_directory`, {})
    expect(read.status).toBe(200)
    expect(yield* read.json).toMatchObject({ ok: true, result: { agents: [] } })
  }))

test.skipIf(!rpcSet)('website SIWE prepares an offer and serves its manifest, but is not a hosted MCP grant',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const account = privateKeyToAccount(generatePrivateKey())
    const challenge = (yield* (yield* postJson(`${apiUrl}/api/auth_challenge`, { address: account.address })).json) as { result: { message: string } }
    const signature = yield* Effect.promise(() => account.signMessage({ message: challenge.result.message }))
    const login = (yield* (yield* postJson(`${apiUrl}/api/auth_login`, { message: challenge.result.message, signature })).json) as { ok: boolean; result: { session: string } }
    expect(login.ok).toBe(true)
    const token = login.result.session
    const created = yield* postJson(`${apiUrl}/api/create_task`, {
      title: 'stack test', brief: 'nothing is published', acceptanceCriteria: [], token: 'mUSD', reward: '1', creatorBond: '0', workerBond: '0',
      deliveryDeadline: Math.floor(Date.now() / 1000) + 3600, mode: 'hire', stack: 'main',
    }, { authorization: `Bearer ${token}` })
    const body = (yield* created.json) as { ok: boolean; result: { termsHash: string; transactions: unknown[] } }
    expect(body.ok).toBe(true)
    expect(body.result.transactions.length).toBeGreaterThan(0)
    const manifest = yield* HttpClient.get(`${apiUrl}/offers/${body.result.termsHash}.json`)
    expect(manifest.status).toBe(200)
    expect(((yield* manifest.json) as { title: string }).title).toBe('stack test')
  }))

test('tenant boards: a board route that does not exist, CORS only for allowed origins, the boards listing',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const missing = yield* postJson(`${apiUrl}/b/nope/api/protocol_info`, {})
    expect(missing.status).toBe(404)
    expect(((yield* missing.json) as { code: string }).code).toBe('not-found')
    const preflight = yield* HttpClient.execute(HttpClientRequest.options(`${apiUrl}/b/public/api/list_tasks`, { headers: { origin: 'https://evil.example' } }))
    expect(preflight.status).toBe(204)
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined()
    const boards = yield* HttpClient.get(`${apiUrl}/data/boards`)
    const body = (yield* boards.json) as { ok: boolean; boards: Array<{ id: string; public: boolean }> }
    expect(body.ok).toBe(true)
    expect(body.boards.find((b) => b.id === 'public')?.public).toBe(true)
  }))

test.skipIf(!rpcSet)('tenant boards: sign in over REST, create a board, use its route, get CORS on its origin, refused token',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const account = privateKeyToAccount(generatePrivateKey())
    const rest = <T>(tool: string, body: unknown, session?: string) =>
      Effect.gen(function* () {
        const r = yield* postJson(`${apiUrl}/api/${tool}`, body, session === undefined ? {} : { authorization: `Bearer ${session}` })
        return (yield* r.json) as { ok: boolean; result: T; code?: string; message?: string }
      })
    const { result: challenge } = yield* rest<{ message: string }>('auth_challenge', { address: account.address })
    const signature = yield* Effect.promise(() => account.signMessage({ message: challenge.message }))
    const login = yield* rest<{ session: string; boardId: string }>('auth_login', { message: challenge.message, signature })
    expect(login.ok).toBe(true)
    expect(login.result.boardId).toBe('public')
    const slug = `t-${Math.random().toString(36).slice(2, 8)}`
    const created = yield* rest<{ board: { id: string; owner: string; tokens: Array<{ symbol: string }> } }>(
      'create_board',
      { slug, name: 'Stack test board', stacks: ['main'], rewardTokens: ['mUSD'], allowedOrigins: ['https://host.example'], drip: false },
      login.result.session,
    )
    expect(created.ok).toBe(true)
    expect(created.result.board.owner).toBe(account.address)
    expect(created.result.board.tokens.map((t) => t.symbol)).toEqual(['mUSD'])
    const info = yield* postJson(`${apiUrl}/b/${slug}/api/protocol_info`, {}, { origin: 'https://host.example' })
    expect(info.status).toBe(200)
    expect(info.headers['access-control-allow-origin']).toBe('https://host.example')
    const listed = (yield* (yield* HttpClient.get(`${apiUrl}/data/boards`)).json) as { boards: Array<{ id: string }> }
    expect(listed.boards.some((b) => b.id === slug)).toBe(true)
    // The same session works on the new board (one session store), and its token subset is enforced.
    const refused = yield* postJson(`${apiUrl}/b/${slug}/api/create_task`, {
      title: 't', brief: 'b', acceptanceCriteria: [], token: 'mEUR', reward: '1', creatorBond: '0', workerBond: '0',
      deliveryDeadline: Math.floor(Date.now() / 1000) + 3600, mode: 'hire',
    }, { authorization: `Bearer ${login.result.session}` })
    expect(refused.status).toBe(400)
    expect(((yield* refused.json) as { message: string }).message).toMatch(/pays in mUSD/)
    const who = yield* rest<{ address: string; boardId: string }>('whoami', {}, login.result.session)
    expect(who.result.address).toBe(account.address)
  }))

test('hosted MCP requires OAuth and advertises exact public and tenant protected resources',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    for (const resourcePath of ['/mcp', '/b/public/mcp']) {
      const denied = yield* postJson(`${apiUrl}${resourcePath}`, { jsonrpc: '2.0', id: 1, method: 'initialize' })
      expect(denied.status).toBe(401)
      expect(denied.headers['www-authenticate']).toContain(`/.well-known/oauth-protected-resource${resourcePath}`)
      const metadata = yield* HttpClient.get(`${apiUrl}/.well-known/oauth-protected-resource${resourcePath}`)
      expect(metadata.status).toBe(200)
      expect(yield* metadata.json).toMatchObject({ resource: `${apiUrl}${resourcePath}`, authorization_servers: [apiUrl], scopes_supported: ['sidequest:read', 'sidequest:hire', 'sidequest:work'] })
    }
    const discovery = yield* HttpClient.get(`${apiUrl}/.well-known/oauth-authorization-server`)
    expect(discovery.status).toBe(200)
    expect(yield* discovery.json).toMatchObject({ token_endpoint: `${apiUrl}/oauth/token`, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] })
  }))

test('OAuth registration and authorize enforce exact redirect/resource and the website origin in workerd',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const bad = yield* postJson(`${apiUrl}/oauth/register`, { redirect_uris: ['http://untrusted.example/callback'] })
    expect(bad.status).toBe(400)
    const registration = yield* postJson(`${apiUrl}/oauth/register`, { redirect_uris: ['http://localhost:3333/callback'], client_name: 'Workerd OAuth client' })
    expect(registration.status).toBe(201)
    const client = (yield* registration.json) as { client_id: string }
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://localhost:3333/callback', response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', scope: 'sidequest:read', resource: `${apiUrl}/mcp` })
    const evilOrigin = yield* HttpClient.get(`${apiUrl}/oauth/authorize?${query}`, { headers: { origin: 'https://evil.example' } })
    expect(evilOrigin.status).toBe(403)
    query.set('resource', 'https://evil.example/mcp')
    const evilResource = yield* HttpClient.get(`${apiUrl}/oauth/authorize?${query}`)
    expect(evilResource.status).toBe(400)
    query.set('resource', `${apiUrl}/b/public/mcp`)
    query.set('redirect_uri', 'http://localhost:3334/callback')
    expect((yield* HttpClient.get(`${apiUrl}/oauth/authorize?${query}`)).status).toBe(400)
    const consent = yield* postJson(`${apiUrl}/oauth/requests/oauth_${'a'.repeat(40)}/approve`, { agentIds: ['someone-else'] }, { origin: 'https://evil.example' })
    expect(consent.status).toBe(403)
  }))


test('agent lifecycle and approval routes refuse unauthenticated and cross-origin decisions',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    for (const path of ['/api/agents', '/api/approvals', '/api/agents/not-owned/recovery']) {
      const response = yield* HttpClient.get(`${apiUrl}${path}`)
      expect(response.status).toBe(401)
    }
    const create = yield* postJson(`${apiUrl}/api/agents`, { id: 'fixture', name: 'fixture' }, { origin: new URL(apiUrl!).origin })
    expect(create.status).toBe(401)
    const foreign = yield* postJson(`${apiUrl}/api/agents/not-owned/stop-access`, {}, { origin: 'https://foreign.invalid' })
    expect(foreign.status).toBe(403)
  }))
