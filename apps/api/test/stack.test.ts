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

const mcp = (apiUrl: string | undefined, method: string, params: unknown, session?: string | undefined) =>
  Effect.gen(function* () {
    const response = yield* postJson(
      `${apiUrl}/mcp`,
      { jsonrpc: '2.0', id: 1, method, params },
      session === undefined ? {} : { 'mcp-session-id': session },
    )
    const body = (yield* response.json) as { result?: any; error?: any }
    return { body, session: response.headers['mcp-session-id'] }
  })

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

test('MCP: initialize opens a session and lists the board tools',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const init = yield* mcp(apiUrl, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })
    expect(init.body.result.protocolVersion).toBe('2025-06-18')
    expect(init.session).toBeTypeOf('string')
    const list = yield* mcp(apiUrl, 'tools/list', {}, init.session)
    const names = (list.body.result.tools as Array<{ name: string }>).map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['protocol_info', 'auth_login', 'create_task', 'build_activation', 'submit_work']))
    const info = yield* mcp(apiUrl, 'tools/call', { name: 'protocol_info', arguments: {} }, init.session)
    const infoBody = JSON.parse(info.body.result.content[0].text) as { chainId: number }
    expect(infoBody.chainId).toBe(10143)
    const denied = yield* mcp(apiUrl, 'tools/call', { name: 'create_task', arguments: {} }, init.session)
    expect(denied.body.result.isError).toBe(true)
    expect(denied.body.result.content[0].text).toMatch(/^unauthenticated/)
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
    const init = yield* mcp(apiUrl, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'directory-test', version: '1' } })
    const list = yield* mcp(apiUrl, 'tools/list', {}, init.session)
    expect((list.body.result.tools as Array<{ name: string }>).map((entry) => entry.name)).toEqual(expect.arrayContaining(['list_directory', 'get_directory_agent', 'prepare_agent_profile', 'enroll_directory', 'post_heartbeat', 'publish_service_ad']))
    const read = yield* mcp(apiUrl, 'tools/call', { name: 'list_directory', arguments: {} }, init.session)
    expect(read.body.result.isError).not.toBe(true)
    expect(JSON.parse(read.body.result.content[0].text).agents).toEqual([])
  }))

test.skipIf(!rpcSet)('sign in over MCP, create an offer, and serve its manifest',
  Effect.gen(function* () {
    const { apiUrl } = yield* stack
    const account = privateKeyToAccount(generatePrivateKey())
    const init = yield* mcp(apiUrl, 'initialize', { protocolVersion: '2025-06-18' })
    const challenge = yield* mcp(apiUrl, 'tools/call', { name: 'auth_challenge', arguments: { address: account.address } }, init.session)
    const { message } = JSON.parse(challenge.body.result.content[0].text) as { message: string }
    const signature = yield* Effect.promise(() => account.signMessage({ message }))
    const login = yield* mcp(apiUrl, 'tools/call', { name: 'auth_login', arguments: { message, signature } }, init.session)
    expect(login.body.result.isError).toBeUndefined()
    const who = yield* mcp(apiUrl, 'tools/call', { name: 'whoami', arguments: {} }, init.session)
    expect(JSON.parse(who.body.result.content[0].text)).toMatchObject({ address: account.address, boardId: 'public' })

    const created = yield* mcp(apiUrl, 'tools/call', {
      name: 'create_task',
      arguments: {
        title: 'stack test',
        brief: 'nothing is published',
        acceptanceCriteria: [],
        token: 'mUSD',
        reward: '1',
        creatorBond: '0',
        workerBond: '0',
        deliveryDeadline: Math.floor(Date.now() / 1000) + 3600,
        mode: 'hire',
        stack: 'demo',
      },
    }, init.session)
    const task = JSON.parse(created.body.result.content[0].text) as { termsHash: string; manifestUrl: string; transactions: unknown[] }
    expect(task.transactions.length).toBeGreaterThan(0)
    const manifest = yield* HttpClient.get(`${apiUrl}/offers/${task.termsHash}.json`)
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
      { slug, name: 'Stack test board', stacks: ['demo'], rewardTokens: ['mUSD'], allowedOrigins: ['https://host.example'], drip: false },
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
