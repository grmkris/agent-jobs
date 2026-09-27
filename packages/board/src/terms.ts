/**
 * Offers (spec §1 "Offers"): each task publishes one frozen `OfferTerms` snapshot. Its `termsHash` is the listing's
 * on-chain `policyHash`, and the snapshot is also the content-addressed manifest in public R2. It binds mode, token,
 * reward, both bonds, deadlines, approver, criteria, evidence policy, the originating quote when there is one, and
 * the deployment it is valid on; the listing must match it on every enforceable field.
 */
import { type Address, type Hex, keccak256, stringToHex } from 'viem'
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
  windows: EvaluatorWindows
  eligibility: EligibilityPolicy | null
  evidencePolicy: EvidencePolicy | null
  /** A quoted hire carries the request and the picked quote (R20 quote-to-hire). */
  quote: { requestHash: Hex; quoteHash: Hex } | null
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
  }
}

export class TermsError extends Error {
  constructor(
    readonly code:
      | 'windows-mismatch'
      | 'listing-mismatch'
      | 'terms-hash-mismatch'
      | 'invalid-deadlines'
      | 'invalid-amounts'
      | 'contest-worker-bond',
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
export function validateOffer(offer: OfferTerms, evaluator: EvaluatorWindows, now: number): void {
  if (canonicalJson(offer.windows) !== canonicalJson(evaluator)) {
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
  )
}
