import { agentFailureReply } from '@sidequest/board'
import type { OAuthGrant } from './oauth.ts'
import { OAUTH_SCOPES } from './oauth-validation.ts'
import { permittedTool, requiredToolScope } from './mcp-policy.ts'
import { ROLE_GUIDES, connectorInstructions } from './mcp-instructions.ts'
import type { McpEvents } from './mcp-events.ts'
import { EventRpcError } from './webhooks.ts'

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
export const MODERN_LANE = true
const MODERN_VERSION = '2026-07-28'

export interface McpReply {
  readonly status: number
  readonly body?: unknown
  readonly headers?: Record<string, string>
}

export interface McpTool {
  readonly description?: string
  readonly inputSchema?: Record<string, unknown>
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): McpReply {
  return { status, body, headers: { 'cache-control': 'no-store', ...headers } }
}

export async function mcpRoute(input: {
  readonly method: string
  readonly pathname: string
  readonly body: Record<string, unknown>
  readonly headers: Record<string, string | undefined>
  readonly events?: McpEvents
  /** Testable rollback switch; production uses MODERN_LANE. */
  readonly modernLane?: boolean
  readonly grant?: OAuthGrant
  readonly tools: Record<string, McpTool>
  readonly call: (tool: string, args: Record<string, unknown>, agentId: string) => Promise<unknown>
  readonly origin: string
}): Promise<McpReply> {
  const { method, pathname, body, grant, tools, call, origin } = input
  if (grant === undefined) return json({ ok: false, code: 'unauthenticated', message: 'A resource-scoped OAuth bearer token is required' }, 401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${pathname}"` })
  if (method === 'GET') return json({ ok: false, code: 'method-not-allowed', message: 'SSE is not offered' }, 405)
  if (method === 'DELETE') return { status: 204, headers: { 'cache-control': 'no-store' } }
  if (method !== 'POST') return json({ ok: false, code: 'method-not-allowed' }, 405)
  const methodName = typeof body.method === 'string' ? body.method : ''
  const id = body.id
  const params = typeof body.params === 'object' && body.params !== null ? body.params as Record<string, unknown> : {}
  const meta = typeof params._meta === 'object' && params._meta !== null ? params._meta as Record<string, unknown> : {}
  const version = meta['io.modelcontextprotocol/protocolVersion']
  const modern = MODERN_LANE && (input.modernLane ?? true) && (methodName === 'server/discover' || typeof version === 'string')
  const rpcError = (code: number, message: string, status = 200, data?: unknown) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }, status)
  if (modern) {
    const name = methodName === 'resources/read' ? params.uri : params.name
    const expected = { 'mcp-protocol-version': version, 'mcp-method': methodName, ...(['tools/call', 'prompts/get', 'resources/read'].includes(methodName) ? { 'mcp-name': name } : {}) }
    if (Object.entries(expected).some(([header, value]) => input.headers[header] !== undefined && input.headers[header] !== value)) return rpcError(-32020, 'MCP header does not match the request body', 400)
    if (typeof version === 'string' && version !== MODERN_VERSION) return rpcError(-32022, 'Unsupported protocol version', 400, { supportedVersions: [MODERN_VERSION] })
  }
  const respond = (result: Record<string, unknown>) => json({ jsonrpc: '2.0', id: id ?? null, result: modern ? { ...result, resultType: 'complete', ...(methodName.endsWith('/list') ? { ttlMs: 0, cacheScope: 'private' } : {}) } : result })
  if (id === undefined && methodName !== 'notifications/initialized') return { status: 202, headers: { 'cache-control': 'no-store' } }
  if (modern && methodName === 'server/discover') return respond({ resultType: 'complete', supportedVersions: [MODERN_VERSION], capabilities: { tools: { listChanged: false }, prompts: {}, resources: {}, events: {} }, instructions: connectorInstructions(origin), ttlMs: 0, cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'sidequest', version: '2.0.0' } } })
  if (methodName === 'initialize') {
    return respond({ protocolVersion: typeof body.params === 'object' && body.params !== null && PROTOCOLS.includes((body.params as { protocolVersion?: string }).protocolVersion as typeof PROTOCOLS[number]) ? (body.params as { protocolVersion: typeof PROTOCOLS[number] }).protocolVersion : PROTOCOLS[0], capabilities: { tools: { listChanged: false }, prompts: {}, resources: {}, events: {} }, serverInfo: { name: 'sidequest', version: '2.0.0' }, instructions: connectorInstructions(origin) })
  }
  if (methodName === 'ping') return respond({})
  if (methodName === 'tools/list') {
    return respond({ tools: Object.entries({ ...tools, get_instructions: { description: 'Read the full connector, worker or publisher role instructions.', inputSchema: { type: 'object', properties: { role: { type: 'string', enum: ['connector', 'worker', 'publisher'] } } } } })
      .filter(([name]) => permittedTool(grant, name)).map(([name, tool]) => {
        const schema = tool.inputSchema ?? { type: 'object', properties: {} }
        const write = requiredToolScope(name) !== 'sidequest:read'
        const existingRequired = Array.isArray((schema as { required?: unknown }).required) ? (schema as unknown as { required: string[] }).required : []
        return { name, description: tool.description, inputSchema: { ...schema, properties: { ...(schema.properties as Record<string, unknown>), ...(write ? { operationKey: { type: 'string', description: 'Persist this stable unique action key before calling. Reuse it with identical arguments after any lost response.' } } : {}) }, ...(write ? { required: [...existingRequired, 'operationKey'] } : {}) } }
      }) })
  }
  if (methodName === 'prompts/list') return respond({ prompts: [{ name: 'find_work', description: 'Find available work' }, { name: 'hire', description: 'Hire a worker' }, { name: 'check_status', description: 'Check a job status' }] })
  if (methodName === 'resources/list') return respond({ resources: Object.keys(ROLE_GUIDES).map(role => ({ uri: `sidequest://skills/${role}`, name: role, mimeType: 'text/markdown' })) })
  if (methodName.startsWith('events/') && input.events !== undefined) {
    try { return respond(await input.events.handle(methodName, params, grant)) }
    catch (error) {
      if (error instanceof EventRpcError) return rpcError(error.code, error.message)
      return rpcError(-32603, 'Events are unavailable')
    }
  }
  if (methodName === 'prompts/get') {
    const prompts: Record<string, string> = { find_work: 'Read get_instructions(role=worker), list available jobs and quotes, and propose suitable work. Check the frozen terms, bond and arbitrator before activation.', hire: 'Read get_instructions(role=publisher), write public acceptance criteria and request quotes. Inspect quotes and select a worker within the allowance.', check_status: 'Read the task and its chain status. Report which actor must act next and any deadline. Reconcile pending operations before retries.' }
    const text = prompts[String(params.name)]
    if (text !== undefined) return respond({ messages: [{ role: 'user', content: { type: 'text', text } }] })
  }
  if (methodName === 'resources/read') {
    const role = String(params.uri).replace(/^sidequest:\/\/skills\//, '') as keyof typeof ROLE_GUIDES
    if (Object.hasOwn(ROLE_GUIDES, role)) return respond({ contents: [{ uri: params.uri, mimeType: 'text/markdown', text: ROLE_GUIDES[role] }] })
  }
  if (methodName === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : ''
    const tool = tools[name]
    const args = typeof params.arguments === 'object' && params.arguments !== null ? params.arguments as Record<string, unknown> : {}
    if (!permittedTool(grant, name)) return respond({ content: [{ type: 'text', text: 'forbidden: this connection does not grant this tool' }], isError: true })
    if (name === 'get_instructions') {
      const role = typeof args.role === 'string' ? args.role : 'connector'
      return respond(Object.hasOwn(ROLE_GUIDES, role) ? { content: [{ type: 'text', text: ROLE_GUIDES[role as keyof typeof ROLE_GUIDES] }] } : { content: [{ type: 'text', text: 'invalid role' }], isError: true })
    }
    if (tool === undefined) return respond({ content: [{ type: 'text', text: `not-found: no tool ${name}` }], isError: true })
    const agentId = typeof args.managedAgentId === 'string' ? args.managedAgentId : grant.agentIds.length === 1 ? grant.agentIds[0]! : ''
    if (!grant.agentIds.includes(agentId)) return respond({ content: [{ type: 'text', text: 'forbidden: select one granted agent' }], isError: true })
    try {
      const output = await call(name, args, agentId)
      const failed = typeof output === 'object' && output !== null && (output as { ok?: boolean }).ok === false
      return respond({ content: [{ type: 'text', text: JSON.stringify(output) }], ...(failed ? { isError: true } : {}) })
    }
    catch (error) { return respond({ content: [{ type: 'text', text: JSON.stringify(agentFailureReply(error, 'The tool failed')) }], isError: true }) }
  }
  return json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `method not found: ${methodName}` } }, 200)
}

export { OAUTH_SCOPES }
