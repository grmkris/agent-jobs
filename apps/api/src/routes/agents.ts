/** HTTP parsing only. The management object authenticates and owns every lifecycle write. */
export interface AgentRouteRequest {
  readonly action: string
  readonly id?: string
  readonly body: Record<string, unknown>
  readonly avatarBytes?: Uint8Array
}

export function agentRoute(method: string, path: string, body: Record<string, unknown>): AgentRouteRequest | undefined {
  if (path === '/api/agents' && method === 'GET') return { action: 'list', body }
  if (path === '/api/agents' && method === 'POST') return { action: 'create', body }
  if (path === '/api/agents/setup-identity' && method === 'POST') return { action: 'setup-identity', body }
  const generate = /^\/api\/agents\/([A-Za-z0-9_-]{1,128})\/avatar\/generate$/.exec(path)
  if (generate !== null && method === 'POST') return { action: 'avatar-generate', id: generate[1]!, body }
  const match = /^\/api\/agents\/([A-Za-z0-9_-]{1,128})(?:\/([a-z-]+))?$/.exec(path)
  if (match === null) return undefined
  const id = match[1]!
  const action = match[2] ?? 'status'
  if (method === 'GET' && (action === 'status' || action === 'recovery')) return { action, id, body }
  if (
    method === 'POST' &&
    [
      'resume',
      'registration-prepare',
      'registration-confirm',
      'registration-batch',
      'registration-record',
      'allowance-prepare',
      'allowance-confirm',
      'stop-access',
      'revoke',
      'signer-removed',
      'execute',
      'profile',
      'avatar',
      'approve',
    ].includes(action)
  )
    return { action, id, body }
  return undefined
}
