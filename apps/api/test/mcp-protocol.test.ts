import { DatabaseSync } from 'node:sqlite'
import { fromNodeSqlite } from '@sidequest/indexer'
import { describe, expect, it, vi } from 'vitest'
import { mcpRoute, MODERN_LANE } from '../src/mcp.ts'
import { McpEvents } from '../src/mcp-events.ts'
import { connectorInstructions } from '../src/mcp-instructions.ts'
import type { OAuthGrant } from '../src/oauth.ts'

const origin = 'https://sidequest.test'
const grant: OAuthGrant = { owner: 'operator', address: '0x1111111111111111111111111111111111111111', chainId: 10143, scopes: ['sidequest:read'], agentIds: ['a1'], registryAgentId: '7', clientId: 'c', resource: `${origin}/mcp` }
const tools = { get_task: { description: 'Read task', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } } }
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }
const route = (method: string, params: Record<string, unknown> = {}, overrides: Partial<Parameters<typeof mcpRoute>[0]> = {}) => mcpRoute({ method: 'POST', pathname: '/mcp', origin, headers: {}, body: { jsonrpc: '2.0', id: 1, method, params }, grant, tools, call: async () => ({ ok: true, result: { taskId: 't1' } }), ...overrides })
const result = (value: Awaited<ReturnType<typeof mcpRoute>>) => (value.body as { result: Record<string, unknown> }).result

describe('2026-07-28 MCP lane', () => {
  it('discovers without initialize, with serverInfo only in _meta', async () => {
    expect(MODERN_LANE).toBe(true)
    expect(result(await route('server/discover', { _meta: meta }))).toEqual({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: { listChanged: false }, prompts: {}, resources: {}, events: {} }, instructions: connectorInstructions(origin), ttlMs: 0, cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'sidequest', version: '2.0.0' } } })
    expect(result(await route('server/discover'))).not.toHaveProperty('serverInfo')
  })
  it.each(['tools/list', 'prompts/list', 'resources/list', 'events/list'])('decorates modern %s', async method => {
    const events = new McpEvents(fromNodeSqlite(new DatabaseSync(':memory:')), 'monad-testnet')
    expect(result(await route(method, { _meta: meta }, { events }))).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' })
  })
  it('keeps tools/call content shape and decorates only its result', async () => {
    expect(result(await route('tools/call', { _meta: meta, name: 'get_task', arguments: { taskId: 't1' } }))).toEqual({ resultType: 'complete', content: [{ type: 'text', text: '{"ok":true,"result":{"taskId":"t1"}}' }] })
  })
  it.each([
    ['tools/list', {}, { 'mcp-method': 'tools/call' }],
    ['tools/list', {}, { 'mcp-protocol-version': '2025-06-18' }],
    ['tools/call', { name: 'get_task' }, { 'mcp-name': 'list_tasks' }],
    ['prompts/get', { name: 'hire' }, { 'mcp-name': 'find_work' }],
    ['resources/read', { uri: 'sidequest://skills/worker' }, { 'mcp-name': 'sidequest://skills/publisher' }],
  ])('rejects inconsistent modern headers for %s', async (method, params, headers) => {
    const reply = await route(method, { ...params, _meta: meta }, { headers })
    expect(reply.status).toBe(400)
    expect(reply.body).toMatchObject({ error: { code: -32020 } })
  })
  it('accepts matching modern headers including a resource URI', async () => {
    const reply = await route('resources/read', { uri: 'sidequest://skills/worker', _meta: meta }, { headers: { 'mcp-method': 'resources/read', 'mcp-name': 'sidequest://skills/worker', 'mcp-protocol-version': '2026-07-28' } })
    expect(reply.status).toBe(200)
    expect(result(reply)).toHaveProperty('resultType', 'complete')
  })
  it('reports unsupported body versions with supportedVersions and HTTP 400', async () => {
    const reply = await route('tools/list', { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2027-01-01' } }, { headers: { 'mcp-protocol-version': '2027-01-01' } })
    expect(reply.status).toBe(400)
    expect(reply.body).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32022, message: 'Unsupported protocol version', data: { supportedVersions: ['2026-07-28'] } } })
  })
  it('auth precedes malformed modern metadata, and never invokes events without a grant', async () => {
    const input = { method: 'POST', pathname: '/mcp', origin, headers: { 'mcp-method': 'wrong' }, body: { id: 1, method: 'server/discover', params: { _meta: meta } }, tools, call: vi.fn() }
    expect(await mcpRoute(input)).toEqual({ status: 401, headers: { 'cache-control': 'no-store', 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }, body: { ok: false, code: 'unauthenticated', message: 'A resource-scoped OAuth bearer token is required' } })
    expect(input.call).not.toHaveBeenCalled()
  })
  it('decorates custom poll results too', async () => {
    const events = new McpEvents(fromNodeSqlite(new DatabaseSync(':memory:')), 'monad-testnet')
    expect(result(await route('events/poll', { _meta: meta, name: 'sidequest.inbox' }, { events }))).toMatchObject({ resultType: 'complete', events: [], cursor: 'v1:0', hasMore: false, truncated: false, nextPollMs: 60000 })
  })
})

describe('legacy wire snapshots and rollback', () => {
  // Captured pre-WS5 response shape; only the initialize events capability changes.
  it.each([true, false])('keeps initialize/tools responses byte-identical with modernLane=%s', async modernLane => {
    const initialize = { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false }, prompts: {}, resources: {} }, serverInfo: { name: 'sidequest', version: '2.0.0' }, instructions: connectorInstructions(origin) }
    const reply = await route('initialize', { protocolVersion: '2025-03-26' }, { modernLane })
    const actual = result(reply)
    expect(actual.capabilities).toHaveProperty('events', {})
    const { events: _events, ...capabilities } = actual.capabilities as Record<string, unknown>
    expect(JSON.stringify({ ...actual, capabilities })).toBe(JSON.stringify(initialize))
    expect(JSON.stringify((await route('tools/list', {}, { modernLane })).body)).toBe(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [
      { name: 'get_task', description: 'Read task', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
      { name: 'get_instructions', description: 'Read the full connector, worker or publisher role instructions.', inputSchema: { type: 'object', properties: { role: { type: 'string', enum: ['connector', 'worker', 'publisher'] } } } },
    ] } }))
    expect(JSON.stringify((await route('tools/call', { name: 'get_task', arguments: { taskId: 't1' } }, { modernLane })).body)).toBe('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true,\\"result\\":{\\"taskId\\":\\"t1\\"}}"}]}}')
  })
  it('disables all modern handling while retaining legacy events', async () => {
    const events = new McpEvents(fromNodeSqlite(new DatabaseSync(':memory:')), 'monad-testnet')
    expect((await route('server/discover', { _meta: meta }, { modernLane: false })).body).toMatchObject({ error: { code: -32601 } })
    const reply = await route('events/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': 'bad' } }, { modernLane: false, events, headers: { 'mcp-method': 'wrong' } })
    expect(reply.status).toBe(200)
    expect(result(reply)).not.toHaveProperty('resultType')
    expect(result(reply)).not.toHaveProperty('ttlMs')
    expect(result(reply).events).toHaveLength(4)
  })
})
