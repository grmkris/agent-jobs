/** Bounded testnet worker policy. Model output is data; this module grants no signing authority. */
import { type Address, formatUnits, parseUnits, sha256 } from 'viem'
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

/** What a worker reads of an invited task (`get_task`): its frozen terms and where they live. */
export interface DemoInvite {
  taskId: string
  stack: string
  kind: string
  termsHash: string
  terms: Record<string, unknown>
}

/**
 * A direct invitation's frozen terms in the request shape the worker bids on and delivers against. It has no quote:
 * requestHash is empty and the quote deadline is the delivery deadline.
 */
export function inviteRequest(invite: DemoInvite): DemoRequest {
  const t = invite.terms
  const deployment = t.deployment as { chainId?: number } | undefined
  const evidence = t.evidencePolicy as { checks?: string[] } | null | undefined
  let workerBond = ''
  try { workerBond = formatUnits(BigInt(String(t.workerBond)), 18) } catch { workerBond = 'invalid' }
  return {
    requestId: `task-${invite.taskId}`, requestHash: '', chainId: deployment?.chainId ?? 0, stack: invite.stack, creator: String(t.creator),
    title: String(t.title), brief: String(t.brief), acceptanceCriteria: Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria.map(String) : [],
    tokens: [String(t.token)], workerBond, deliveryDeadline: Number(t.deliveryDeadline), quoteDeadline: Number(t.deliveryDeadline),
    requiredChecks: evidence?.checks ?? [], windows: t.windows as DemoRequest['windows'], arbitrator: String(t.arbitrator),
    ...(t.deliverable === undefined ? {} : { deliverable: t.deliverable as NonNullable<DemoRequest['deliverable']> }),
  }
}

/** The request policy plus what only an invitation decides: a v1 hire with no quote, paying at least the worker's price. */
export function inviteProblem(invite: DemoInvite, policy: DemoPolicy, minimumReward: bigint, now: number): string | undefined {
  const t = invite.terms
  if (invite.kind !== 'sidequest-v1' || t.mode !== 'hire') return 'Only the current Monad testnet v1 stack is supported'
  if (t.quote !== null && t.quote !== undefined) return 'A picked quote follows the quote flow'
  try { if (BigInt(String(t.reward)) < minimumReward) return 'The reward is below this worker\'s price' }
  catch { return 'Invalid reward' }
  return requestProblem(inviteRequest(invite), policy, now)
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
