/**
 * What the board's tools return, typed once for every consumer (Explore, the widget, a host's own UI). These mirror
 * the board service's replies; amounts are strings in base units unless a field says otherwise.
 */
export interface TxRequest {
  description: string
  chainId: number
  to: `0x${string}`
  data: `0x${string}`
  value: '0'
  /** The gas limit to send with, in decimal, when the call needs more than an estimate (Monad charges the limit). */
  gas?: string
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

/** An operating advance: the worker draws up to `cap` of `token` into its own wallet (ADR-0009). */
export interface AdvanceBudgetTerms {
  kind: 'advance'
  token: `0x${string}`
  cap: string
  expiresAt: number
}
/** A call budget: one call to one contract function from the creator's account (the creator owns what it makes). */
export interface CallBudgetTerms {
  kind: 'call'
  target: `0x${string}`
  function: string
  cap: string
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
  /** ADR-0009: base units of `token` (a call budget: wei of native value); null when the offer has none. */
  executionBudget: AdvanceBudgetTerms | CallBudgetTerms | null
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
  /** Indexed Hireling v1 activation and settlement accounting; unknown before those events. */
  net?: string | null
  charged_fee?: string | null
  bonus?: string | null
  /** ADR-0008: the board the offer was frozen on; null for a listing published outside any hosted board. */
  board_id?: string | null
}

/** `get_budget`: a task's execution budget as the parties see it (amounts in token units). */
export interface Budget {
  taskId: string
  kind: 'advance' | 'call'
  token?: `0x${string}`
  target?: `0x${string}`
  function?: string
  symbol: string
  cap: string
  /** An advance: what the enforcer counted on-chain. A call: the value of the calls the board saw. */
  drawn: string
  remaining: string
  calls?: { made: number; allowed: 1 }
  expiresAt: number
  status: 'promised' | 'live' | 'revoked' | 'ended'
  endedReason: string | null
  enforcement: string
  /** Whether the chain would still honour the signed delegation (not expired, not disabled). */
  redeemable: boolean
  worker: `0x${string}` | null
  draws: Array<{ drawId: string; amount: string | null; selector?: string; note: string; status: 'prepared' | 'confirmed' | 'failed'; txHash: string | null; at: number }>
  delegation: { manager: `0x${string}`; delegation: Record<string, unknown> } | null
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

/** A tenant board (ADR-0008) as `get_board` / `list_boards` / `/data/boards` return it. */
export interface BoardInfo {
  id: string
  name: string
  owner: string | null
  stacks: string[]
  defaultStack: string
  rewardTokens: `0x${string}`[]
  tokens: Array<{ address: `0x${string}`; symbol: string; decimals: number }>
  deliverableDefault?: DeliverableSpec
  defaultApprover?: `0x${string}`
  allowedOrigins: string[]
  drip: boolean
  sponsor: 'none' | 'privy' | 'pimlico'
  verifiers: Record<string, `0x${string}`[]>
  webhookUrl?: string
  createdAt: number
  public: boolean
}

/** What `create_task` returns: the frozen offer and what the creator's wallet must send. */
export interface CreatedTask {
  taskId: string
  termsHash: string
  manifestUrl: string
  screening: { verdict: string; reasons: string[] } | null
  transactions: TxRequest[]
}

/** An EIP-712 message for the caller's wallet (`eth_signTypedData_v4`). */
export interface SignRequest {
  description: string
  typedData: string
}
