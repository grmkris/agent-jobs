import { expect, test } from 'vitest'
import type { Address } from 'viem'
import type { BoardCall } from '../src/board.ts'
import { managementRequest, operatorRequest, tenantAgentRequest } from '../src/agent-requests.ts'
import { admissionIpHash } from '../src/admission-rate.ts'

const operator: Address = '0x1111111111111111111111111111111111111111'
const agent: Address = '0x2222222222222222222222222222222222222222'
const edgeIp = '2001:db8::1234'
const spoofedIp = '192.0.2.99'
const env: BoardCall['env'] = {
  network: 'monad-mainnet', boardId: 'public', rpcUrl: '', domain: 'sidequest.test', uri: 'https://sidequest.test', manifestBaseUrl: '',
  screening: { baseUrl: '', apiKey: '', model: '' }, attesterKey: '', relayKey: '', github: { appId: '', privateKeyPem: '', installationId: '' },
}

test.each([
  { action: 'execute', tool: 'request_unstake', tenantTool: 'request_unstake' },
  { action: 'execute', tool: 'withdraw_stake', tenantTool: 'withdraw_stake' },
  { action: 'approval-decide', tool: 'create_task', tenantTool: 'report_transaction' },
  { action: 'approval-retry', tool: 'create_task', tenantTool: 'report_operation' },
])('$action/$tenantTool retains edge admission identity through operator continuation', async ({ action, tool, tenantTool }) => {
  const body = { ip: spoofedIp, args: { ip: spoofedIp }, operationKey: 'body-key' }
  const management = managementRequest(env, { action, id: 'agent', body }, 'operator-session', {
    'cf-connecting-ip': edgeIp, 'x-forwarded-for': spoofedIp,
  })
  const execution = operatorRequest(management, operator, { agentId: 'agent', tool, args: body.args, key: 'saved-operation', boardId: 'original-board' })
  const tenant = tenantAgentRequest(execution, agent, tenantTool, { ip: spoofedIp, txHash: 'public-hash' })
  expect(management.ip).toBe(edgeIp)
  expect(execution.ip).toBe(edgeIp)
  expect(tenant.ip).toBe(edgeIp)
  expect(await admissionIpHash(tenant.ip)).toBe(await admissionIpHash(edgeIp))
  expect(tenant).toMatchObject({ caller: agent, bearer: 'operator-session', env: { boardId: 'original-board' }, agentAuth: { agentId: 'agent', operator: true } })
  expect(execution.args.operationKey).toBe('saved-operation')
  expect(body.operationKey).toBe('body-key')
})

test('missing edge IP refuses admission even when the body or forwarded headers supply an IP', async () => {
  const management = managementRequest(env, { action: 'execute', body: { ip: spoofedIp } }, 'operator-session', { 'x-forwarded-for': spoofedIp })
  const execution = operatorRequest(management, operator, { agentId: 'agent', tool: 'withdraw_stake', args: { ip: spoofedIp }, key: 'saved-operation' })
  const tenant = tenantAgentRequest(execution, agent, 'withdraw_stake', { ip: spoofedIp })
  expect(management.ip).toBeUndefined()
  expect(execution.ip).toBeUndefined()
  await expect(admissionIpHash(tenant.ip)).rejects.toThrow('edge client IP')
})

test('OAuth tenant continuations retain their own edge IP and credential without operator authority', () => {
  const tenant = tenantAgentRequest({ env, tool: 'report_operation', args: {}, agentId: 'agent', resource: `${env.uri}/mcp`, ip: edgeIp, bearer: 'oauth-token' }, agent, 'report_operation', {})
  expect(tenant).toMatchObject({ ip: edgeIp, bearer: 'oauth-token', caller: agent, agentAuth: { agentId: 'agent', resource: `${env.uri}/mcp` } })
  expect(tenant.agentAuth?.operator).toBeUndefined()
})
