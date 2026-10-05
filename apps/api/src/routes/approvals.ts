import type { AgentRouteRequest } from './agents.ts'

export function approvalRoute(method: string, path: string, body: Record<string, unknown>): AgentRouteRequest | undefined {
  if (path === '/api/approvals' && method === 'GET') return { action: 'approvals', body }
  const match = /^\/api\/approvals\/(0x[0-9a-fA-F]{64})\/(prepare|decide|retry)$/.exec(path)
  if (match === null || method !== 'POST') return undefined
  return { action: `approval-${match[2]}`, id: match[1]!, body }
}
