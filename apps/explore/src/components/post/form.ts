/**
 * The Post form as data: its fields, the defaults a prefill (the embed widget) overrides, the exact arguments the
 * board's `create_task` and `request_quotes` tools receive, and the draft kept in localStorage per board and address.
 * Pure, so the tool arguments are unit-tested (form.test.ts) and never drift from what the board expects.
 */
import { parseUnits } from 'viem'
import type { DeliverableKind, TxRequest } from '../../api.ts'
import { formatNumber, tokenInfo } from '../../format.ts'

export type Mode = 'hire' | 'contest' | 'quotes'
export type StackName = 'main' | 'demo' | 'fast'
export type Step = 1 | 2 | 3 | 4

export interface PostForm {
  mode: Mode
  title: string
  brief: string
  /** Acceptance criteria, one per line. */
  criteria: string
  token: string
  reward: string
  quoteTokens: string[]
  quoteHours: string
  deliveryHours: string
  selectionHours: string
  creatorBond: string
  workerBond: string
  check: string
  accepts: DeliverableKind[]
  target: string
  stack: StackName
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

/** The prefill's token (a symbol or an address) among the known reward tokens. */
export function prefillToken(prefill: Record<string, string>, tokens: TokenList): string | undefined {
  const want = prefill.token?.toLowerCase()
  if (want === undefined) return undefined
  return tokens.find(([a, t]) => t.symbol.toLowerCase() === want || a === want)?.[0]
}

/** A fresh form: the defaults, with whatever the embed widget prefilled (title, brief, reward, token, mode). */
export function initialForm(prefill: Record<string, string>, tokens: TokenList, mainnet: boolean): PostForm {
  const first = tokens[0]?.[0] ?? ''
  return {
    mode: prefill.mode === 'contest' || prefill.mode === 'quotes' ? prefill.mode : 'hire',
    title: prefill.title ?? '',
    brief: prefill.brief ?? '',
    criteria: 'A GitHub check run named "test" completes with conclusion "success" on the submitted SHA.',
    token: prefillToken(prefill, tokens) ?? first,
    reward: prefill.reward ?? '10',
    quoteTokens: tokens.map(([a]) => a),
    quoteHours: '6',
    deliveryHours: '48',
    selectionHours: '24',
    creatorBond: mainnet ? '0' : '2',
    workerBond: mainnet ? '0' : '1',
    check: 'test',
    accepts: ['git'],
    target: '',
    stack: 'main',
    budgetOn: false,
    budgetKind: 'advance',
    budgetToken: first,
    budgetCap: '2',
    callTarget: mainnet ? '' : NADFUN_TESTNET.target,
    callFunction: mainnet ? '' : NADFUN_TESTNET.function,
    callCap: NADFUN_TESTNET.cap,
  }
}

export const criteriaList = (criteria: string) => criteria.split('\n').map((l) => l.trim()).filter((l) => l !== '')

/** Git only with no target is the default: the field is left out so the terms stay as before (ADR-0006). */
function deliverableArg(f: PostForm) {
  return f.accepts.length === 1 && f.accepts[0] === 'git' && f.target.trim() === '' ? {} : { deliverable: { accepts: f.accepts, ...(f.target.trim() === '' ? {} : { target: f.target.trim() }) } }
}
const checksArg = (f: PostForm) => (f.check.trim() === '' || !f.accepts.includes('git') ? {} : { requiredChecks: [f.check.trim()] })
const hoursFrom = (now: number, hours: string) => now + Math.round(Number(hours) * 3600)

/** `create_task`'s arguments for a hire or a contest, frozen at `now` (unix seconds). */
export function createTaskArgs(f: PostForm, now: number) {
  const mode = f.mode === 'contest' ? 'contest' : 'hire'
  return {
    title: f.title,
    brief: f.brief,
    acceptanceCriteria: criteriaList(f.criteria),
    token: f.token,
    reward: f.reward,
    creatorBond: f.creatorBond,
    workerBond: mode === 'contest' ? '0' : f.workerBond,
    deliveryDeadline: hoursFrom(now, f.deliveryHours),
    mode,
    ...(mode === 'contest' ? { selectionDeadline: hoursFrom(now, f.selectionHours) } : {}),
    ...checksArg(f),
    ...deliverableArg(f),
    ...(mode === 'hire' && f.budgetOn
      ? {
          executionBudget:
            f.budgetKind === 'call'
              ? { kind: 'call', target: f.callTarget.trim(), function: f.callFunction.trim(), cap: f.callCap }
              : { kind: 'advance', token: f.budgetToken.trim(), cap: f.budgetCap },
        }
      : {}),
    stack: f.stack,
  }
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
    stack: f.stack,
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
  if (step !== 3) return null
  if (f.mode === 'quotes') {
    if (f.quoteTokens.length === 0) return 'Accept at least one token.'
    if (!positive(f.quoteHours)) return 'Say when quoting closes.'
    if (Number(f.quoteHours) >= Number(f.deliveryHours)) return 'Quoting must close before the delivery deadline.'
  } else {
    if (f.token === '') return 'Choose a reward token.'
    if (!positive(f.reward)) return 'Set a reward above zero.'
  }
  if (!positive(f.deliveryHours)) return 'Say how many hours the agent has to deliver.'
  if (f.mode === 'contest' && (!positive(f.selectionHours) || Number(f.selectionHours) >= Number(f.deliveryHours))) {
    return 'The award must come before the delivery deadline.'
  }
  if (!nonNegative(f.creatorBond) || (f.mode !== 'contest' && !nonNegative(f.workerBond))) return 'Bonds must be zero or more.'
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
  fp: string
  at: number
  deliveryDeadline: number
  selectionDeadline: number | null
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
  JSON.stringify(Object.fromEntries(['title', 'brief', 'reward', 'token', 'mode'].filter((k) => prefill[k] !== undefined).map((k) => [k, prefill[k]])))

export const draftKey = (boardId: string, address: string | undefined) => `hireling.post-draft:${boardId}:${address?.toLowerCase() ?? 'signed-out'}`

/** The stored draft, completed with today's defaults for any field it predates; null when there is none. */
export function loadDraft(key: string, defaults: PostForm): Draft | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Draft> | null
    if (raw === null || raw.v !== 1 || typeof raw.form !== 'object' || raw.form === null) return null
    const step = raw.step === 2 || raw.step === 3 || raw.step === 4 ? raw.step : 1
    return { v: 1, step, form: { ...defaults, ...raw.form }, prefill: typeof raw.prefill === 'string' ? raw.prefill : '{}', frozen: raw.frozen ?? null }
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
