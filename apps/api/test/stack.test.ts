import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Effect from 'effect/Effect'
import * as HttpBody from 'effect/unstable/http/HttpBody'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import * as HttpClient from 'effect/unstable/http/HttpClient'
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
    expect(JSON.parse(who.body.result.content[0].text)).toEqual({ address: account.address })

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
