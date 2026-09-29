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

export type DeliverableKind = 'git' | 'patch' | 'artifact' | 'url' | 'onchain'
export const DELIVERABLE_KINDS: ReadonlyArray<{ kind: DeliverableKind; label: string }> = [
  { kind: 'git', label: 'git (any host)' },
  { kind: 'patch', label: 'patch' },
  { kind: 'artifact', label: 'file' },
  { kind: 'url', label: 'live URL' },
  { kind: 'onchain', label: 'on-chain' },
]
export interface DeliverableSpec {
  accepts: DeliverableKind[]
  target?: string
}
/** Where a submitted deliverable is (ADR-0006); the board hosts none of it. */
export type Deliverable =
  | { kind: 'git'; url: string; ref: string; sha: string }
  | { kind: 'patch'; url: string; sha256: string; base: string }
  | { kind: 'artifact'; url: string; sha256: string; mediaType: string; name: string }
  | { kind: 'url'; url: string }
  | { kind: 'onchain'; chainId: number; txHash?: string; address?: string }
/** The board's one-time check at submit: null when it could not tell. */
export interface DeliverableCheck {
  ok: boolean | null
  detail: string
  checkedAt: number
}

export interface TokenBudgetTerms {
  kind?: undefined
  token: `0x${string}`
  cap: string
  expiresAt: number
}
/** A call budget: the worker calls one contract function from the creator's wallet (the creator owns what it makes). */
export interface CallBudgetTerms {
  kind: 'call'
  target: `0x${string}`
  function: string
  cap: string
  expiresAt: number
}

/** An x402 budget: the worker pays x402 endpoints in the chain's USDC from the creator's wallet, capped per payment. */
export interface X402BudgetTerms {
  kind: 'x402'
  token: `0x${string}`
  cap: string
  perCall: string
  expiresAt: number
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
  /** ADR-0005: base units of `token` (a call budget: wei of native value); null when the offer has none. */
  executionBudget: TokenBudgetTerms | CallBudgetTerms | X402BudgetTerms | null
  /** ADR-0006: the deliverable forms the offer accepts (git only when absent). */
  deliverable?: DeliverableSpec
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

/** `get_budget`: a task's execution budget as the parties see it (amounts in token units). */
export interface Budget {
  taskId: string
  kind?: 'token' | 'call' | 'x402'
  perCall?: string
  payer?: `0x${string}`
  token?: `0x${string}`
  target?: `0x${string}`
  function?: string
  symbol: string
  cap: string
  spent: string
  reserved: string
  remaining: string
  expiresAt: number
  status: 'promised' | 'live' | 'revoked' | 'ended'
  endedReason: string | null
  spends: Array<{ spendId: string; to: string; amount: string; selector?: string; note: string; status: string; txHash: string | null; at: number }>
  cleanup:
    | null
    | { removeSigners: true; address: string; why: string }
    | { replaceSigner: { address: string; signerId: string; policyId: string }; why: string }
}

export interface QuoteRequest {
  requestId: string
  requestHash: string
  status: string
  creator: string
  title: string
  brief: string
  acceptanceCriteria: string[]
  tokens: string[]
  creatorBond: string
  workerBond: string
  deliveryDeadline: number
  quoteDeadline: number
  stack: string
}

export interface Quote {
  quoteId: string
  worker: string
  agentId: string
  token: string
  symbol: string
  amount: string
  note: string
  expectedCosts: { token: string; symbol: string; amount: string; note: string } | null
  quoteHash: string
}
