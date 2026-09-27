/**
 * The board's REST API (`POST /api/<tool>`) and the indexer's chain facts (`GET /data/...`), same-origin through the
 * Explore Worker. The session token from sign-in is kept in sessionStorage for this tab only.
 */
const SESSION_KEY = 'agent-jobs.session'

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function session(): string | null {
  return sessionStorage.getItem(SESSION_KEY)
}

export function setSession(token: string | null) {
  if (token === null) sessionStorage.removeItem(SESSION_KEY)
  else sessionStorage.setItem(SESSION_KEY, token)
}

export async function tool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const token = session()
  const res = await fetch(`/api/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(args),
  })
  const body = (await res.json()) as { ok: boolean; result?: T; code?: string; message?: string }
  if (!body.ok) {
    if (body.code === 'unauthenticated') setSession(null)
    throw new ApiError(body.code ?? String(res.status), body.message ?? 'request failed')
  }
  return body.result as T
}

export async function data<T = any>(path: string): Promise<T> {
  const res = await fetch(`/data/${path}`)
  const body = (await res.json()) as T & { ok: boolean; message?: string }
  if (!body.ok) throw new ApiError('data', body.message ?? 'not available')
  return body
}

export interface TxRequest {
  description: string
  chainId: number
  to: `0x${string}`
  data: `0x${string}`
  value: '0'
}

export interface TaskIndexEntry {
  taskId: string
  jobId: string | null
  stack: string
  title: string
  brief: string
  acceptanceCriteria: string[]
  mode: 'hire' | 'contest'
  token: `0x${string}`
  reward: string
  creatorBond: string
  workerBond: string
  creator: `0x${string}`
  approver: `0x${string}`
  deliveryDeadline: number
  selectionDeadline: number | null
  requiredChecks: string[]
  quoted: boolean
  termsHash: string
  manifestUrl: string
  screening: { verdict: string; reasons: string[] }
  createdAt: number
}

export interface ChainJob {
  job_id: string
  stack: string | null
  mode: string | null
  status: string
  creator: string | null
  approver: string | null
  token: string | null
  reward: string | null
  creator_bond: string | null
  worker_bond: string | null
  worker: string | null
  agent_id: string | null
  delivery_deadline: number | null
  selection_deadline: number | null
  deliverable: string | null
  violation: string | null
  published_tx: string | null
}
