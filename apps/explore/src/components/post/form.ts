/**
 * The Post form as data: its fields, the defaults a prefill (the embed widget) overrides, the exact arguments the
 * board's `create_task` and `request_quotes` tools receive, and the draft kept in localStorage per board and address.
 * Pure, so the tool arguments are unit-tested (form.test.ts) and never drift from what the board expects.
 */
import { formatUnits, isAddress, parseUnits } from 'viem'
import { DELIVERABLE_KINDS, type DeliverableKind, type TaskIndexEntry, type TxRequest } from '../../api.ts'
import { formatNumber, tokenInfo, tokenMeta } from '../../format.ts'
import { deployment } from '../../wallet.ts'
import { duration } from '../../duration.ts'

/** A direct hire, or a request for quotes (ADR-0011: Hireling v1 publishes no contests). */
export type Mode = 'hire' | 'quotes'
export type Step = 1 | 2 | 3 | 4
export type WindowPreset = 'fast' | 'standard' | 'long' | 'custom'

/** Preferred spans in hours; deployment bounds clamp them. Fast uses the chain minimums. */
const WINDOW_PREFERENCES = {
  standard: [24, 24, 48],
  long: [72, 72, 168],
} as const
const clampedHours = ([min, max]: readonly [number, number], seconds: number) => String(Math.max(min, Math.min(max, seconds)) / 3600)

/** The Holding's window bounds, in seconds (`MIN_REVIEW_WINDOW` … `MAX_ARBITRATION_WINDOW`), read from the chain. */
export interface WindowBounds {
  review: readonly [number, number]
  dispute: readonly [number, number]
  arbitration: readonly [number, number]
}

export interface PostForm {
  mode: Mode
  /** A direct hire's named agent (ERC-8004 number), or empty for any agent that applies. */
  invite: string
  title: string
  brief: string
  /** Acceptance criteria, one per line. */
  criteria: string
  token: string
  reward: string
  quoteTokens: string[]
  quoteHours: string
  deliveryHours: string
  creatorBond: string
  workerBond: string
  check: string
  accepts: DeliverableKind[]
  target: string
  /** The offer's windows, a preset or custom hours. */
  windowPreset: WindowPreset
  reviewHours: string
  disputeHours: string
  arbitrationHours: string
  /** A custom arbitrator's address; empty for Hireling's arbiter (the Holding's default). */
  arbitrator: string
  budgetOn: boolean
  budgetKind: 'advance' | 'call'
  budgetToken: string
  budgetCap: string
  callTarget: string
  callFunction: string
  callCap: string
}

/** What `create_task` answers: the frozen offer, the advisory screening and the transactions that publish it. */
export interface Created {
  taskId: string
  termsHash: string
  manifestUrl: string
  screening: { verdict: string; reasons: string[] } | null
  transactions: TxRequest[]
}

/** nad.fun's launch call on Monad testnet: a call budget for it makes the creator the token's creator (ADR-0005). */
export const NADFUN_TESTNET = {
  target: '0x865054F0F6A288adaAc30261731361EA7E908003',
  function: 'function create((string name,string symbol,string tokenURI,uint256 amountOut,bytes32 salt,uint8 actionId) params) payable',
  cap: '12',
}

type TokenList = ReadonlyArray<readonly [string, { symbol: string }]>

/** The prefill's token: any ERC-20 address (ADR-0010), or the symbol of a known token. */
export function prefillToken(prefill: Record<string, string>, tokens: TokenList): string | undefined {
  const want = prefill.token?.trim().toLowerCase()
  if (want === undefined || want === '') return undefined
  if (isAddress(want, { strict: false })) return want
  return tokens.find(([, t]) => t.symbol.toLowerCase() === want)?.[0]
}

const KINDS = new Set<string>(DELIVERABLE_KINDS.map((k) => k.kind))

/**
 * A fresh form: the defaults, with whatever was prefilled. The embed widget names the title, brief, reward, token
 * and mode; Hire again (`hireAgainPrefill`) also names the rest of a past offer's terms.
 */
export function initialForm(prefill: Record<string, string>, tokens: TokenList, mainnet: boolean): PostForm {
  const first = tokens[0]?.[0] ?? ''
  const accepts = prefill.accepts?.split(',').filter((k): k is DeliverableKind => KINDS.has(k)) ?? []
  const budget = prefill.budget === 'advance' || prefill.budget === 'call' ? prefill.budget : null
  return {
    mode: prefill.mode === 'quotes' ? 'quotes' : 'hire',
    invite: /^\d+$/.test(prefill.agentId ?? '') ? (prefill.agentId as string) : '',
    title: prefill.title ?? '',
    brief: prefill.brief ?? '',
    criteria: prefill.criteria ?? 'A GitHub check run named "test" completes with conclusion "success" on the submitted SHA.',
    token: prefillToken(prefill, tokens) ?? first,
    reward: prefill.reward ?? '10',
    quoteTokens: tokens.map(([a]) => a),
    quoteHours: '6',
    deliveryHours: prefill.deliveryHours ?? '48',
    creatorBond: prefill.creatorBond ?? (mainnet ? '0' : '2'),
    workerBond: prefill.workerBond ?? (mainnet ? '0' : '1'),
    check: prefill.check ?? 'test',
    accepts: accepts.length > 0 ? accepts : ['git'],
    target: prefill.target ?? '',
    windowPreset: 'standard',
    reviewHours: '24',
    disputeHours: '24',
    arbitrationHours: '48',
    arbitrator: '',
    budgetOn: budget !== null,
    budgetKind: budget ?? 'advance',
    budgetToken: budget === 'advance' && prefill.budgetToken !== undefined ? prefill.budgetToken : first,
    budgetCap: budget === 'advance' && prefill.budgetCap !== undefined ? prefill.budgetCap : '2',
    callTarget: budget === 'call' && prefill.callTarget !== undefined ? prefill.callTarget : mainnet ? '' : NADFUN_TESTNET.target,
    callFunction: budget === 'call' && prefill.callFunction !== undefined ? prefill.callFunction : mainnet ? '' : NADFUN_TESTNET.function,
    callCap: budget === 'call' && prefill.callCap !== undefined ? prefill.callCap : NADFUN_TESTNET.cap,
  }
}

/**
 * Hire again: a paid job's offer as a prefill for a new hire with the same agent, token, reward and terms (brief,
 * criteria, deliverable forms, check, bonds, running-cost budget, and as long to deliver). Amounts come
 * back in the units people type; `decimals` are the reward token's (and an advance budget's, `budgetDecimals`).
 */
export function hireAgainPrefill(job: { jobId: string; agentId: string; worker: string; task: TaskIndexEntry; decimals: number; budgetDecimals?: number }): Record<string, string> {
  const t = job.task
  const eb = t.executionBudget
  return {
    mode: 'hire',
    again: job.jobId,
    agentId: job.agentId,
    worker: job.worker,
    title: t.title,
    brief: t.brief,
    criteria: t.acceptanceCriteria.join('\n'),
    token: t.token,
    reward: formatUnits(BigInt(t.reward), job.decimals),
    creatorBond: formatUnits(BigInt(t.creatorBond), 18),
    workerBond: formatUnits(BigInt(t.workerBond), 18),
    deliveryHours: String(Math.max(1, Math.round((t.deliveryDeadline - t.createdAt) / 3600))),
    accepts: (t.deliverable?.accepts ?? ['git']).join(','),
    target: t.deliverable?.target ?? '',
    check: t.requiredChecks[0] ?? '',
    ...(eb === null
      ? {}
      : eb.kind === 'advance'
        ? { budget: 'advance', budgetToken: eb.token, budgetCap: formatUnits(BigInt(eb.cap), job.budgetDecimals ?? job.decimals) }
        : { budget: 'call', callTarget: eb.target, callFunction: eb.function, callCap: formatUnits(BigInt(eb.cap), 18) }),
  }
}

export const criteriaList = (criteria: string) => criteria.split('\n').map((l) => l.trim()).filter((l) => l !== '')

/** Git only with no target is the default: the field is left out so the terms stay as before (ADR-0006). */
function deliverableArg(f: PostForm) {
  return f.accepts.length === 1 && f.accepts[0] === 'git' && f.target.trim() === '' ? {} : { deliverable: { accepts: f.accepts, ...(f.target.trim() === '' ? {} : { target: f.target.trim() }) } }
}
const checksArg = (f: PostForm) => (f.check.trim() === '' || !f.accepts.includes('git') ? {} : { requiredChecks: [f.check.trim()] })
const hoursFrom = (now: number, hours: string) => now + Math.round(Number(hours) * 3600)

/**
 * `create_task`'s arguments for a direct hire, frozen at `now` (unix seconds): with the named agent (`invite`,
 * decision D3) so it can be selected at once, the offer's windows and, when not Hireling's arbiter, the arbitrator.
 */
export function createTaskArgs(f: PostForm, now: number) {
  return {
    title: f.title,
    brief: f.brief,
    acceptanceCriteria: criteriaList(f.criteria),
    token: f.token,
    reward: f.reward,
    creatorBond: f.creatorBond,
    workerBond: f.workerBond,
    deliveryDeadline: hoursFrom(now, f.deliveryHours),
    mode: 'hire' as const,
    ...checksArg(f),
    ...deliverableArg(f),
    ...(f.budgetOn
      ? {
          executionBudget:
            f.budgetKind === 'call'
              ? { kind: 'call', target: f.callTarget.trim(), function: f.callFunction.trim(), cap: f.callCap }
              : { kind: 'advance', token: f.budgetToken.trim(), cap: f.budgetCap },
        }
      : {}),
    ...(f.invite.trim() !== '' ? { invite: { agentId: f.invite.trim() } } : {}),
    windows: windowsOf(f),
    ...(f.arbitrator.trim() === '' ? {} : { arbitrator: f.arbitrator.trim() }),
  }
}

/** Resolve a preset before review/freeze, keeping its actual hours in the saved offer. Custom values stay explicit. */
export function windowForm(f: PostForm, bounds: WindowBounds | null): PostForm {
  if (bounds === null || f.windowPreset === 'custom') return f
  const preferred = f.windowPreset === 'fast' ? [bounds.review[0], bounds.dispute[0], bounds.arbitration[0]] as const : WINDOW_PREFERENCES[f.windowPreset].map((hours) => hours * 3600)
  return { ...f, reviewHours: clampedHours(bounds.review, preferred[0]!), disputeHours: clampedHours(bounds.dispute, preferred[1]!), arbitrationHours: clampedHours(bounds.arbitration, preferred[2]!) }
}

/** The resolved offer's windows in seconds, preserved when reloading a frozen offer. */
export function windowsOf(f: Pick<PostForm, 'windowPreset' | 'reviewHours' | 'disputeHours' | 'arbitrationHours'>) {
  const [review, dispute, arbitration] = [Number(f.reviewHours), Number(f.disputeHours), Number(f.arbitrationHours)]
  return { reviewSeconds: Math.round(review * 3600), disputeSeconds: Math.round(dispute * 3600), arbitrationSeconds: Math.round(arbitration * 3600) }
}

/**
 * Why a hire's windows or arbitrator would be refused at publish, in words; null when they are fine. `bounds` are
 * the Holding's (null while they are read); `me` is the creator, who approves its own offers.
 */
export function hireTermsProblem(f: PostForm, bounds: WindowBounds | null, me: string | undefined): string | null {
  if (bounds === null) return 'Reading the window limits from the chain…'
  const w = windowsOf(windowForm(f, bounds))
  const checks: Array<[string, number, readonly [number, number]]> = [
    ['review', w.reviewSeconds, bounds.review],
    ['dispute', w.disputeSeconds, bounds.dispute],
    ['arbitration', w.arbitrationSeconds, bounds.arbitration],
  ]
  for (const [name, value, [min, max]] of checks) {
    if (!Number.isFinite(value) || value < min || value > max) return `The ${name} window must be between ${duration(min)} and ${duration(max)}.`
  }
  const a = f.arbitrator.trim()
  if (a !== '') {
    if (!isAddress(a, { strict: false }) || /^0x0{40}$/i.test(a)) return 'Enter the arbitrator’s address (0x and 40 hex digits).'
    if (me !== undefined && a.toLowerCase() === me.toLowerCase()) return 'You cannot arbitrate your own job: you are its creator and approver.'
  }
  return null
}

/** `request_quotes`' arguments: accepted tokens instead of a price, and when quoting closes. */
export function requestQuotesArgs(f: PostForm, now: number) {
  return {
    title: f.title,
    brief: f.brief,
    acceptanceCriteria: criteriaList(f.criteria),
    tokens: f.quoteTokens,
    creatorBond: f.creatorBond,
    workerBond: f.workerBond,
    deliveryDeadline: hoursFrom(now, f.deliveryHours),
    quoteDeadline: hoursFrom(now, f.quoteHours),
    ...checksArg(f),
    ...deliverableArg(f),
  }
}

/** Identifies the offer a form would freeze, apart from the moment: a frozen offer is reused only while this matches. */
export const fingerprint = (f: PostForm) => JSON.stringify(f.mode === 'quotes' ? requestQuotesArgs(f, 0) : createTaskArgs(f, 0))

const positive = (v: string) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) > 0
const nonNegative = (v: string) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0

/** Why a step cannot continue yet, in words; null when it can. */
export function stepProblem(f: PostForm, step: Step): string | null {
  if (step === 1) {
    if (f.title.trim() === '') return 'Give the job a title.'
    if (f.brief.trim() === '') return 'Describe what needs doing.'
    return null
  }
  if (step === 2) return f.mode === 'hire' && f.invite.trim() !== '' && !/^\d+$/.test(f.invite.trim()) ? 'An agent number is digits, like 1942.' : null
  if (step !== 3) return null
  if (f.mode === 'quotes') {
    if (f.quoteTokens.length === 0) return 'Accept at least one token.'
    if (!positive(f.quoteHours)) return 'Say when quoting closes.'
    if (Number(f.quoteHours) >= Number(f.deliveryHours)) return 'Quoting must close before the delivery deadline.'
  } else {
    if (f.token === '') return 'Choose a reward token.'
    if (!isAddress(f.token, { strict: false })) return 'Enter the token’s contract address (0x and 40 hex digits).'
    const meta = tokenMeta(f.token)
    // The amount is read in the token's own decimals, so they must be known first.
    if (meta === undefined) return 'Waiting for the token’s symbol and decimals from the chain.'
    if (meta.unverified === true && !deployment.stacks.main.openTokens) return 'This network takes only listed tokens for now.'
    if (!positive(f.reward)) return 'Set a reward above zero.'
  }
  if (!positive(f.deliveryHours)) return 'Say how many hours the agent has to deliver.'
  if (!nonNegative(f.creatorBond) || !nonNegative(f.workerBond)) return 'Bonds must be zero or more.'
  if (f.accepts.length === 0) return 'Accept at least one kind of deliverable.'
  if (f.mode === 'hire' && f.budgetOn) {
    if (f.budgetKind === 'call' && (f.callTarget.trim() === '' || f.callFunction.trim() === '' || !positive(f.callCap))) return 'The running-cost budget needs a contract, a function and a cap.'
    if (f.budgetKind === 'advance' && (f.budgetToken.trim() === '' || !positive(f.budgetCap))) return 'The running-cost budget needs a token and a cap.'
  }
  return null
}

/** A decimal amount of `token` in base units, or null when it is not a number. */
export function toBase(value: string, token: string): bigint | null {
  try {
    return parseUnits(value.trim(), tokenInfo(token).decimals)
  } catch {
    return null
  }
}

/** "1,000.5 mUSD" for a decimal amount a person typed; the text as typed if it is not a number. */
export function humanAmount(value: string, symbol: string): string {
  const [whole = '', frac = ''] = value.trim().split('.')
  if (!/^\d+$/.test(whole || '0') || !/^\d*$/.test(frac)) return `${value} ${symbol}`
  const grouped = BigInt(whole || '0').toLocaleString('en-US')
  const f = frac.replace(/0+$/, '')
  return `${f === '' ? grouped : `${grouped}.${f}`} ${symbol}`
}

/** The typed reward as people read it. */
export const rewardText = (f: Pick<PostForm, 'reward' | 'token'>) => {
  const base = toBase(f.reward, f.token)
  const t = tokenInfo(f.token)
  return base === null ? `${f.reward} ${t.symbol}` : `${formatNumber(base, t.decimals)} ${t.symbol}`
}

/** "2 days", "1 week", "36 hours". */
export function hoursText(hours: string): string {
  const h = Number(hours)
  if (!Number.isFinite(h) || h <= 0) return `${hours} hours`
  if (h % 168 === 0) return h === 168 ? '1 week' : `${h / 168} weeks`
  if (h % 24 === 0) return h === 24 ? '1 day' : `${h / 24} days`
  return h === 1 ? '1 hour' : `${h} hours`
}

// ---------------------------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------------------------

/** A frozen offer kept with the draft, so a reload after freezing (or mid-publish) picks up the same offer. */
export interface Frozen {
  owner: string
  form: PostForm
  started?: boolean
  fp: string
  at: number
  deliveryDeadline: number
  created: Created
}

export interface Draft {
  v: 1
  step: Step
  form: PostForm
  /** The prefill the draft started from: a different prefill (the host page asks for another job) starts afresh. */
  prefill: string
  frozen: Frozen | null
}

export const prefillKey = (prefill: Record<string, string>) =>
  JSON.stringify(Object.fromEntries(['title', 'brief', 'reward', 'token', 'mode', 'again', 'agentId'].filter((k) => prefill[k] !== undefined).map((k) => [k, prefill[k]])))

export const draftKey = (boardId: string, address: string | undefined) => `hireling.post-draft:${boardId}:${address?.toLowerCase() ?? 'signed-out'}`

/**
 * The stored draft, completed with today's defaults for any field it predates and without fields it no longer has;
 * null when there is none or it is not a hire or a request for quotes.
 */
export function loadDraft(key: string, defaults: PostForm): Draft | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Draft> | null
    if (raw === null || raw.v !== 1 || typeof raw.form !== 'object' || raw.form === null) return null
    if (raw.form.mode !== 'hire' && raw.form.mode !== 'quotes') return null
    const step = raw.step === 2 || raw.step === 3 || raw.step === 4 ? raw.step : 1
    const frozen = raw.frozen !== null && typeof raw.frozen === 'object' && typeof raw.frozen.owner === 'string' && typeof raw.frozen.form === 'object' && raw.frozen.form !== null ? raw.frozen as Frozen : null
    const saved = raw.form as Partial<Record<keyof PostForm, unknown>>
    const form = Object.fromEntries((Object.keys(defaults) as Array<keyof PostForm>).map((k) => [k, saved[k] ?? defaults[k]])) as unknown as PostForm
    return { v: 1, step, form, prefill: typeof raw.prefill === 'string' ? raw.prefill : '{}', frozen }
  } catch {
    return null
  }
}

/** Saves the draft; false when the browser refuses storage (a private window), so the page does not claim it saved. */
export function saveDraft(key: string, draft: Draft): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(draft))
    return true
  } catch {
    return false
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // storage blocked: nothing was kept
  }
}
