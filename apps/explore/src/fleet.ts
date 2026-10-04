import { useQuery } from '@tanstack/react-query'
import { ApiError, session } from './api.ts'

export interface ManagedAgent {
  id: string
  name: string
  owner: string
  walletAddress: string
  privyWalletId?: string
  agentId?: string
  kind: 'privy' | 'external'
  status: 'created' | 'paired' | 'launched' | 'ready' | 'healthy' | 'stale' | 'stopped'
  policyId?: string
  generation: number
  createdAt: number
  lastHeartbeatAt?: number
  companionVersion?: string
  deviceFingerprint?: string
}

export interface Approval {
  id: string
  agentId: string
  owner: string
  action: string
  payload: Record<string, unknown>
  createdAt: number
  expiresAt: number
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  operationId: string
  execution?: { state: 'claimed' | 'completed'; claimId?: string; transactionHashes?: string[] }
}

export interface LiveOverview {
  asOf: number
  agents: ManagedAgent[]
  approvals: Approval[]
  activity: Array<{
    id: string
    agentId: string
    kind: string
    createdAt: number
    detail: unknown
  }>
  index: { next_block?: number; updated_at?: number } | null
  chainHead?: number
}

const OWNER_SESSION = 'hireling.operator-session'
export function saveOperatorSession(address: string, token: string, expiresAt: number): void {
  try {
    localStorage.setItem(OWNER_SESSION, JSON.stringify({ address, token, expiresAt }))
  } catch {
    /* The active browser session still works. */
  }
}
export function clearOperatorSession(): void {
  try {
    localStorage.removeItem(OWNER_SESSION)
  } catch {
    /* Storage can be disabled. */
  }
}
export function operatorSession(address?: string): string | null {
  try {
    const stored = JSON.parse(localStorage.getItem(OWNER_SESSION) ?? 'null') as {
      address: string
      token: string
      expiresAt: number
    } | null
    if (address !== undefined && stored?.address.toLowerCase() === address.toLowerCase() && stored.expiresAt > Date.now() / 1000) return stored.token
  } catch {
    /* Fall back to the current wallet's session. */
  }
  if (address === undefined) return session()
  try {
    const current = JSON.parse(localStorage.getItem('agent-jobs.session-owner') ?? 'null') as {
      address: string
      expiresAt: number
    } | null
    if (current?.address.toLowerCase() === address.toLowerCase() && current.expiresAt > Date.now() / 1000) return session()
  } catch {
    /* A different or expired wallet must sign in as operator. */
  }
  return null
}

/** Owner APIs always carry a website session. OAuth tokens are for the MCP endpoint only. */
export async function fleetRequest<T>(path: string, options: { method?: 'GET' | 'POST'; body?: unknown; owner?: string | undefined } = {}): Promise<T> {
  const token = operatorSession(options.owner)
  if (token === null) throw new ApiError('unauthenticated', 'Sign in with your operator wallet first.')
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    cache: 'no-store',
  })
  const reply = (await response.json()) as { ok: true; result: T } | { ok: false; code?: string; message?: string; error?: string; error_description?: string }
  if (!response.ok || !reply.ok)
    throw new ApiError(
      reply.ok ? 'unavailable' : (reply.code ?? 'unavailable'),
      reply.ok ? 'The service is unavailable.' : (reply.message ?? reply.error_description ?? reply.error ?? 'The service rejected this request.'),
    )
  return reply.result
}

export const useFleet = (owner: string | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ['fleet', owner],
    queryFn: () => fleetRequest<{ agents: ManagedAgent[] }>('/api/agents', { owner }),
    enabled,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
export const useLiveOverview = (owner: string | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ['fleet-live', owner],
    queryFn: () => fleetRequest<LiveOverview>('/api/live', { owner }),
    enabled,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })

export function healthLabel(agent: ManagedAgent, now = Date.now() / 1000): string {
  if (agent.status === 'stopped') return 'Stopped'
  if (agent.lastHeartbeatAt !== undefined) return now - agent.lastHeartbeatAt <= 90 ? 'Health check fresh' : 'Health check stale'
  return {
    created: 'Setup needed',
    paired: 'Paired · not started',
    launched: 'Started · awaiting health',
    ready: 'Ready · awaiting health',
    healthy: 'Awaiting health',
    stale: 'Health check stale',
  }[agent.status]
}

export const humanAction = (action: string): string => action.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
