import { DatabaseSync } from 'node:sqlite'
import { fromNodeSqlite, SPONSOR_OBJECT_NAME } from '@sidequest/board'
import { expect, it, vi } from 'vitest'
import { runAgent, type AgentExecuteRequest } from '../src/agent-runtime.ts'
import { networkTool, permittedTool, requiredToolScope, X402_TOOLS } from '../src/mcp-policy.ts'
import { agentTools } from '../src/tools-agents.ts'
import { mcpRoute } from '../src/mcp.ts'
import type { OAuthGrant } from '../src/oauth.ts'

it('exposes x402_pay only to hire scope on testnet, with an operationKey', async () => {
  expect([...X402_TOOLS]).toEqual(['x402_pay'])
  expect(requiredToolScope('x402_pay')).toBe('sidequest:hire')
  expect(permittedTool({ scopes: ['sidequest:hire'] }, 'x402_pay')).toBe(true)
  expect(permittedTool({ scopes: ['sidequest:read', 'sidequest:work'] }, 'x402_pay')).toBe(false)
  const grant = { scopes: ['sidequest:read', 'sidequest:hire'], agentIds: ['payer'] } as unknown as OAuthGrant
  for (const network of ['monad-testnet', 'monad-mainnet']) {
    const tools = Object.fromEntries(Object.entries(agentTools).filter(([name]) => permittedTool(grant, name) && networkTool(network, name)))
    const reply = await mcpRoute({ method: 'POST', pathname: '/mcp', headers: {}, origin: 'https://dev.sidequest.exchange', grant, tools,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, call: async () => undefined })
    const listed = (reply.body as { result: { tools: Array<{ name: string; inputSchema: { required: string[] } }> } }).result.tools
    const payment = listed.find(tool => tool.name === 'x402_pay')
    if (network === 'monad-testnet') expect(payment?.inputSchema.required).toEqual(['paymentRequired', 'operationKey'])
    else expect(payment).toBeUndefined()
  }
})

it('the management runtime refuses mainnet before constructing a chain client or signer', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const get = vi.fn()
    const req: AgentExecuteRequest = { tool: 'x402_pay', args: { operationKey: 'mainnet', paymentRequired: {} }, agentId: 'payer', resource: 'https://sidequest.exchange/mcp',
      env: { network: 'monad-mainnet', boardId: 'public', rpcUrl: '', domain: 'sidequest.exchange', uri: 'https://sidequest.exchange', manifestBaseUrl: '',
        screening: { baseUrl: '', apiKey: '', model: '' }, attesterKey: '', relayKey: '', github: { appId: '', privateKeyPem: '', installationId: '' } } }
    await expect(runAgent({ req, sql: fromNodeSqlite(db), stateId: 'management', bindings: { NETWORK: 'monad-mainnet', Board: {
      idFromName: (name: string) => { expect(name).toBe(SPONSOR_OBJECT_NAME); return { toString: () => 'management' } }, get,
    } } })).rejects.toMatchObject({ code: 'forbidden', message: 'This tool is not available on this network yet' })
    expect(get).not.toHaveBeenCalled()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([])
  } finally { db.close() }
})
