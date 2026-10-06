/**
 * Offers (spec §1 "Offers"): each task publishes one frozen `OfferTerms` snapshot. Its `termsHash` is the listing's
 * on-chain `policyHash`, and the snapshot is also the content-addressed manifest in public R2. It binds mode, token,
 * reward, both bonds, deadlines, approver, criteria, evidence policy, the originating quote when there is one, and
 * the deployment it is valid on; the listing must match it on every enforceable field.
 */
import { type AbiFunction, type Address, type Hex, isAddress, keccak256, parseAbiItem, stringToHex, zeroAddress } from 'viem'
import { type WindowBounds, validateOfferWindows, windowBounds } from '@agent-jobs/sdk'
import { type DeliverableSpec, validateSpec } from './deliverable.ts'
import type { EligibilityPolicy } from './roles.ts'

/** Named CI checks and the trusted producer an evidence attestation must cover. */
export interface EvidencePolicy {
  checks: readonly string[]
  trustedProducer: string
  workflowPath: string
}

/** The windows the deployed `JobsEvaluator` enforces. Offers cannot choose others. */
export interface EvaluatorWindows {
  reviewSeconds: number
  disputeSeconds: number
  arbitrationSeconds: number
}

/** A project's defaults, resolved into an offer once at publish and never read again for it. */
export interface OfferDefaults {
  token: Hex
  creatorBond: bigint
  workerBond: bigint
  windows: EvaluatorWindows
  evidencePolicy?: EvidencePolicy
}

export type OfferMode = 'hire' | 'contest'

/**
 * An execution budget (ADR-0009): what the creator approved for the worker's running costs, apart from the reward.
 * Nothing is escrowed. Once the worker has activated, the creator signs it as one delegation from its own account
 * (MetaMask Delegation Framework, ERC-7710) and the worker redeems that delegation from its own wallet; the chain's
 * caveat enforcers hold the cap. Hire only.
 */
export type ExecutionBudget = AdvanceBudget | CallBudget

/** An operating advance: the worker draws up to `cap` of `token` into its own wallet and pays its costs from there. */
export interface AdvanceBudget {
  kind: 'advance'
  /** Any ERC-20. */
  token: Address
  /** Base units of `token`, in total across draws. */
  cap: bigint
  /** Unix seconds; at most the delivery deadline. */
  expiresAt: number
}

/**
 * One call from the creator's account to one contract function, e.g. a launchpad's `create()`, so the creator is
 * `msg.sender` and owns what it makes. `cap` bounds the native value the call may send.
 */
export interface CallBudget {
  kind: 'call'
  target: Address
  /** Human-readable ABI of the one allowed function, e.g. `function create((string,string) params) payable`. */
  function: string
  /** Native units (wei) of value. */
  cap: bigint
  /** Unix seconds; at most the delivery deadline. */
  expiresAt: number
}

/** The allowed function of a call budget, parsed; throws on anything that is not one function. */
export function callFunction(b: CallBudget): AbiFunction {
  const item = parseAbiItem(b.function) as AbiFunction | { type: string }
  if (item.type !== 'function') throw new Error('not a function')
  return item as AbiFunction
}

/** Where the offer is valid: the agreement is only ever with these contracts on this chain. */
export interface DeploymentBinding {
  chainId: number
  core: Address
  holding: Address
  evaluator: Address
  identity: Address
}

export interface OfferTerms {
  v: 2
  deployment: DeploymentBinding
  taskId: string
  projectId: string | null
  policyVersion: number | null
  mode: OfferMode
  title: string
  brief: string
  acceptanceCriteria: readonly string[]
  token: Address
  reward: bigint
  creatorBond: bigint
  workerBond: bigint
  /** Unix seconds. */
  deliveryDeadline: number
  /** Contest only; null for a hire. */
  selectionDeadline: number | null
  creator: Address
  approver: Address
  /** The arbitrator frozen into a v1 listing; legacy offers omit this field and use the pair's immutable key. */
  arbitrator?: Address
  windows: EvaluatorWindows
  eligibility: EligibilityPolicy | null
  evidencePolicy: EvidencePolicy | null
  /** A quoted hire carries the request and the picked quote (R20 quote-to-hire). */
  quote: { requestHash: Hex; quoteHash: Hex } | null
  /** Absent (not null) when there is none, so offers without a budget keep their terms hash. */
  executionBudget?: ExecutionBudget
  /**
   * The deliverable forms the creator accepts (ADR-0006). Absent (not null) means git only, so older offers keep
   * their terms hash.
   */
  deliverable?: DeliverableSpec
  /** Distinguishes two publications of the same task (a retry is a new agreement, never a reused one). */
  salt: Hex
}

/** Canonical JSON: keys sorted at every level, bigints as decimal strings, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** keccak256 of the canonical JSON; equal to the listing's on-chain `policyHash` and the manifest key. */
export function termsHash(offer: OfferTerms): Hex {
  return keccak256(stringToHex(canonicalJson(offer)))
}

/** Parses a manifest back into terms (bigints restored). */
export function parseTerms(json: string): OfferTerms {
  const raw = JSON.parse(json) as Record<string, unknown>
  return {
    ...(raw as unknown as OfferTerms),
    reward: BigInt(raw.reward as string),
    creatorBond: BigInt(raw.creatorBond as string),
    workerBond: BigInt(raw.workerBond as string),
    ...(raw.executionBudget === undefined
      ? {}
      : { executionBudget: parseBudget(raw.executionBudget as Record<string, unknown>) }),
  }
}

function parseBudget(b: Record<string, unknown>): ExecutionBudget {
  const cap = BigInt(b.cap as string)
  const expiresAt = b.expiresAt as number
  if (b.kind === 'advance') return { kind: 'advance', token: b.token as Address, cap, expiresAt }
  if (b.kind === 'call') return { kind: 'call', target: b.target as Address, function: b.function as string, cap, expiresAt }
  throw new TermsError('invalid-budget', `unknown execution budget kind: ${String(b.kind)}`)
}

export class TermsError extends Error {
  constructor(
    readonly code:
      | 'windows-mismatch'
      | 'windows-bounds'
      | 'invalid-arbitrator'
      | 'unsupported-mode'
      | 'listing-mismatch'
      | 'terms-hash-mismatch'
      | 'invalid-deadlines'
      | 'invalid-amounts'
      | 'contest-worker-bond'
      | 'invalid-budget'
      | 'invalid-deliverable',
    message: string,
  ) {
    super(message)
  }
}

/**
 * Checks a new offer against the rules the contracts will enforce, so the board never asks a creator to sign a
 * publish that must revert, and against the deployed evaluator's windows.
 * @param now Unix seconds.
 */
export function validateOffer(offer: OfferTerms, evaluator: EvaluatorWindows, now: number, kind: 'legacy' | 'hireling-v1' = 'legacy', bounds: WindowBounds = windowBounds()): void {
  if (kind === 'hireling-v1') {
    validateHirelingWindows(offer.windows, bounds)
    if (offer.mode !== 'hire') throw new TermsError('unsupported-mode', 'Hireling v1 supports hires only.')
    const a = offer.arbitrator
    if (a === undefined || !isAddress(a) || a.toLowerCase() === zeroAddress || eq(a, offer.creator) || eq(a, offer.approver)) {
      throw new TermsError('invalid-arbitrator', 'A v1 offer needs a nonzero arbitrator distinct from its creator and approver.')
    }
  } else if (canonicalJson(offer.windows) !== canonicalJson(evaluator)) {
    throw new TermsError('windows-mismatch', 'Offer windows must equal the deployed evaluator windows.')
  }
  if (offer.reward <= 0n || offer.creatorBond < 0n || offer.workerBond < 0n) {
    throw new TermsError('invalid-amounts', 'The reward must be positive and bonds not negative.')
  }
  if (offer.deliveryDeadline <= now) throw new TermsError('invalid-deadlines', 'The delivery deadline has passed.')
  if (offer.mode === 'contest') {
    if (offer.workerBond !== 0n) throw new TermsError('contest-worker-bond', 'Contests carry no worker bond.')
    if (offer.selectionDeadline === null || offer.selectionDeadline <= now) {
      throw new TermsError('invalid-deadlines', 'A contest needs a future selection deadline.')
    }
    if (offer.selectionDeadline >= offer.deliveryDeadline) {
      throw new TermsError('invalid-deadlines', 'The selection deadline must precede the delivery deadline.')
    }
  } else if (offer.selectionDeadline !== null) {
    throw new TermsError('invalid-deadlines', 'A hire has no selection deadline.')
  }
  if (offer.deliverable !== undefined) {
    const problem = validateSpec(offer.deliverable)
    if (problem !== undefined) throw new TermsError('invalid-deliverable', `Deliverable: ${problem}.`)
    if (offer.evidencePolicy !== null && !offer.deliverable.accepts.includes('git')) {
      throw new TermsError('invalid-deliverable', 'An evidence policy reads CI checks on a commit, so the offer must accept git.')
    }
  }
  const b = offer.executionBudget
  if (b !== undefined) {
    if (offer.mode !== 'hire') throw new TermsError('invalid-budget', 'Only a hire carries an execution budget.')
    if (b.kind === 'advance' && b.cap <= 0n) throw new TermsError('invalid-budget', 'An advance must be positive.')
    if (b.kind === 'call' && b.cap < 0n) throw new TermsError('invalid-budget', 'A call budget cannot send negative value.')
    if (b.kind === 'call') {
      try {
        callFunction(b)
      } catch {
        throw new TermsError('invalid-budget', 'A call budget names exactly one function in human-readable ABI form.')
      }
    }
    if (!Number.isSafeInteger(b.expiresAt) || b.expiresAt <= now || b.expiresAt > offer.deliveryDeadline) {
      throw new TermsError('invalid-budget', 'An execution budget expires in the future and no later than the delivery deadline.')
    }
  }
}

/** What Holding's `getListing(jobId)` reports, reduced to what the agreement must equal. */
export interface OnChainListing {
  creator: Address
  approver: Address
  token: Address
  reward: bigint
  creatorBond: bigint
  workerBond: bigint
  deliveryDeadline: number
  selectionDeadline: number
  mode: number
  policyHash: Hex
  arbitrator?: Address
}

/**
 * Whether the on-chain listing carries exactly this offer. The board shows an offer as funded only when it does,
 * so it can never promise terms the contracts will not honour.
 */
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function listingMatches(offer: OfferTerms, hash: Hex, listing: OnChainListing): boolean {
  return (
    termsHash(offer) === hash &&
    eq(listing.policyHash, hash) &&
    eq(listing.creator, offer.creator) &&
    eq(listing.approver, offer.approver) &&
    eq(listing.token, offer.token) &&
    listing.reward === offer.reward &&
    listing.creatorBond === offer.creatorBond &&
    listing.workerBond === offer.workerBond &&
    listing.deliveryDeadline === offer.deliveryDeadline &&
    listing.selectionDeadline === (offer.selectionDeadline ?? 0) &&
    listing.mode === (offer.mode === 'hire' ? 0 : 1)
    && (offer.arbitrator === undefined || (listing.arbitrator !== undefined && eq(listing.arbitrator, offer.arbitrator)))
  )
}

export interface HirelingWindows {
  reviewSeconds: number
  disputeSeconds: number
  arbitrationSeconds: number
}

/** V1 bounds come from chain/config clocks; production is the fallback for offline legacy records. */
export function validateHirelingWindows(windows: HirelingWindows, bounds: WindowBounds = windowBounds()): void {
  try { validateOfferWindows(windows, bounds) }
  catch (error) { throw new TermsError('windows-bounds', (error as Error).message) }
}
