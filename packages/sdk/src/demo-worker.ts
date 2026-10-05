/** Bounded testnet worker policy. Model output is data; this module grants no signing authority. */
import { type Address, parseUnits, sha256 } from 'viem'
import outputFormats from './demo-worker-formats.json' with { type: 'json' }

export interface DemoRequest {
  requestId: string
  requestHash: string
  chainId: number
  stack: string
  creator: string
  title: string
  brief: string
  acceptanceCriteria: string[]
  tokens: string[]
  workerBond: string
  deliveryDeadline: number
  quoteDeadline: number
  requiredChecks?: string[]
  windows: { reviewSeconds: number; disputeSeconds: number; arbitrationSeconds: number }
  arbitrator: string
  deliverable?: { accepts: string[]; target?: string }
}

export interface DemoPolicy {
  creatorScope: 'any'
  token: Address
  maxBond: bigint
  minimumDeliverySeconds: number
}

function sameAddress(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase()
}

export interface DemoBid {
  kind: 'image' | 'file'
  note: string
  prompt: string
  filename: string
  mediaType: string
}

export function assertSavedDemoArtifact(bytes: Uint8Array | undefined, expectedHash: string): void {
  if (bytes === undefined) throw new Error('Saved artifact is missing; restore the exact pinned bytes before resuming')
  if (sha256(bytes).slice(2) !== expectedHash) throw new Error('Saved artifact bytes changed')
}

export function requestProblem(request: DemoRequest, policy: DemoPolicy, now: number): string | undefined {
  if (request.chainId !== 10143 || request.stack !== 'main') return 'Only the current Monad testnet v1 stack is supported'
  if (!request.tokens.some(token => token.toLowerCase() === policy.token.toLowerCase())) return 'Demo payment token is not accepted'
  if (request.quoteDeadline <= now || request.deliveryDeadline - now < policy.minimumDeliverySeconds) return 'Insufficient time to deliver'
  try { if (parseUnits(request.workerBond, 18) > policy.maxBond || parseUnits(request.workerBond, 18) < 0n) return 'Worker bond is outside policy' }
  catch { return 'Invalid worker bond' }
  if ((request.requiredChecks ?? []).some(check => check !== 'test')) return 'Only the demo artifact test check is supported'
  const accepts = request.deliverable?.accepts ?? ['git']
  if (!accepts.some(kind => kind === 'artifact' || kind === 'git')) return 'Request needs a different delivery adapter'
  if ((request.requiredChecks?.length ?? 0) > 0 && !accepts.includes('git')) return 'CI requirements need a git deliverable'
  if (request.deliverable?.target?.trim()) return 'A named delivery target needs an operator-configured adapter'
  return undefined
}

export function parseDemoBid(value: unknown): DemoBid | null {
  if (value === null || typeof value !== 'object') throw new Error('Invalid bid response')
  const v = value as Record<string, unknown>
  if (v.decline === true) return null
  // The model must explicitly assess safety; missing or uncertain assessments decline.
  if (v.safety !== 'safe') return null
  if ((v.kind !== 'image' && v.kind !== 'file') || typeof v.note !== 'string' || typeof v.prompt !== 'string'
    || typeof v.filename !== 'string' || typeof v.mediaType !== 'string') throw new Error('Invalid bid fields')
  if (v.note.length < 1 || v.note.length > 1000 || v.prompt.length < 1 || v.prompt.length > 6000) throw new Error('Bid exceeds text bounds')
  if (!/^[a-z0-9][a-z0-9_-]{0,70}\.[a-z]{2,5}$/.test(v.filename)) throw new Error('Unsafe or unsupported output filename')
  const extension = v.filename.split('.').at(-1)
  const mediaTypes: Record<string, string> = outputFormats
  if (!extension || !Object.hasOwn(mediaTypes, extension)) throw new Error('Unsafe or unsupported output filename')
  if (mediaTypes[extension!] !== v.mediaType || (v.kind === 'image') !== ['png', 'jpg', 'jpeg'].includes(extension!)) throw new Error('Output kind and media type disagree')
  return { kind: v.kind, note: v.note, prompt: v.prompt, filename: v.filename, mediaType: v.mediaType }
}

export function verifyPickedTerms(request: DemoRequest, terms: Record<string, unknown>, token: Address, reward: bigint) {
  const quote = terms.quote as { requestHash?: string } | undefined
  const windows = terms.windows as DemoRequest['windows'] | undefined
  const deployment = terms.deployment as { chainId?: number } | undefined
  if (deployment?.chainId !== 10143 || !sameAddress(terms.creator, request.creator) || !sameAddress(terms.token, token)
    || terms.title !== request.title || terms.brief !== request.brief || JSON.stringify(terms.acceptanceCriteria) !== JSON.stringify(request.acceptanceCriteria)
    || quote?.requestHash !== request.requestHash || String(terms.reward) !== reward.toString()
    || String(terms.workerBond) !== parseUnits(request.workerBond, 18).toString()
    || terms.deliveryDeadline !== request.deliveryDeadline || !sameAddress(terms.arbitrator, request.arbitrator)
    || windows?.reviewSeconds !== request.windows.reviewSeconds || windows.disputeSeconds !== request.windows.disputeSeconds
    || windows.arbitrationSeconds !== request.windows.arbitrationSeconds) throw new Error('Selected offer differs from the quoted terms')
}

export function verifyBudgetAuthorization(json: string, expected: { core: Address; wallet: Address; jobId: string; token: Address; net: string }) {
  const typed = JSON.parse(json) as { primaryType: string; domain: { chainId: number; verifyingContract: string }; message: Record<string, unknown> }
  if (typed.primaryType !== 'SetBudgetAuthorization' || Number(typed.domain.chainId) !== 10143
    || !sameAddress(typed.domain.verifyingContract, expected.core) || !sameAddress(typed.message.signer, expected.wallet)
    || String(typed.message.jobId) !== expected.jobId || !sameAddress(typed.message.token, expected.token)
    || String(typed.message.amount) !== expected.net) throw new Error('Activation authorization is not for the freshly quoted net payment')
}
