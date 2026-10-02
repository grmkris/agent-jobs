import { describe, expect, it } from 'vitest'
import type { TaskIndexEntry } from '../../api.ts'
import { registerTokens } from '../../format.ts'
import { createTaskArgs, fingerprint, hireAgainPrefill, hoursText, humanAmount, initialForm, prefillKey, requestQuotesArgs, stepProblem, v1TermsProblem, windowsOf } from './form.ts'

const MUSD = '0x1111111111111111111111111111111111111111'
const MEUR = '0x2222222222222222222222222222222222222222'
const tokens = [
  [MUSD, { symbol: 'mUSD' }],
  [MEUR, { symbol: 'mEUR' }],
] as const
const NOW = 1_790_000_000
// Tokens are read (and their decimals known) before a reward in them can be checked.
registerTokens([
  { address: MUSD, symbol: 'mUSD', decimals: 6 },
  { address: MEUR, symbol: 'mEUR', decimals: 6 },
])

describe('the Post form', () => {
  it('takes the embed prefill: title, brief, reward, a token by symbol or address, and the mode', () => {
    const f = initialForm({ title: 'T', brief: 'B', reward: '7', token: 'MEUR', mode: 'quotes' }, tokens, false)
    expect(f).toMatchObject({ title: 'T', brief: 'B', reward: '7', token: MEUR, mode: 'quotes', creatorBond: '2', workerBond: '1' })
    // v1 publishes no contests: a host asking for one gets a direct hire.
    expect(initialForm({ mode: 'contest' }, tokens, false).mode).toBe('hire')
    expect(initialForm({ token: 'CHOMP' }, tokens, false).token).toBe(MUSD)
    expect(initialForm({ token: MEUR }, tokens, false).token).toBe(MEUR)
    // Any ERC-20 by address, listed or not (ADR-0010).
    expect(initialForm({ token: '0x00000000000000000000000000000000000C40A1' }, tokens, false).token).toBe('0x00000000000000000000000000000000000c40a1')
    expect(initialForm({ mode: 'nonsense' }, tokens, true)).toMatchObject({ mode: 'hire', creatorBond: '0', workerBond: '0', callTarget: '' })
  })

  it('sends create_task the same arguments as before for a default hire', () => {
    const f = { ...initialForm({}, tokens, false), title: 'Fix it', brief: 'Fix the bug', criteria: ' one \n\n two ' }
    expect(createTaskArgs(f, NOW)).toEqual({
      title: 'Fix it',
      brief: 'Fix the bug',
      acceptanceCriteria: ['one', 'two'],
      token: MUSD,
      reward: '10',
      creatorBond: '2',
      workerBond: '1',
      deliveryDeadline: NOW + 48 * 3600,
      mode: 'hire',
      requiredChecks: ['test'],
      stack: 'main',
    })
  })

  it('a contest sends no worker bond and a selection deadline; a budget only on a hire', () => {
    const f = { ...initialForm({}, tokens, false), mode: 'contest' as const, selectionHours: '12', budgetOn: true }
    const a = createTaskArgs(f, NOW)
    expect(a).toMatchObject({ mode: 'contest', workerBond: '0', selectionDeadline: NOW + 12 * 3600 })
    expect('executionBudget' in a).toBe(false)
  })

  it('names the deliverable spec only when it differs from git-only, and the check only for git', () => {
    const base = initialForm({}, tokens, false)
    expect(createTaskArgs({ ...base, accepts: ['git', 'url'], target: ' PR against o/r ' }, NOW)).toMatchObject({
      deliverable: { accepts: ['git', 'url'], target: 'PR against o/r' },
      requiredChecks: ['test'],
    })
    const noGit = createTaskArgs({ ...base, accepts: ['artifact'] }, NOW)
    expect(noGit).toMatchObject({ deliverable: { accepts: ['artifact'] } })
    expect('requiredChecks' in noGit).toBe(false)
    expect('requiredChecks' in createTaskArgs({ ...base, check: '  ' }, NOW)).toBe(false)
  })

  it('an execution budget is an advance (token, cap) or a call (contract, function, cap in MON)', () => {
    const base = { ...initialForm({}, tokens, false), budgetOn: true }
    expect(createTaskArgs({ ...base, budgetToken: ` ${MEUR} `, budgetCap: '3' }, NOW).executionBudget).toEqual({ kind: 'advance', token: MEUR, cap: '3' })
    expect(createTaskArgs({ ...base, budgetKind: 'call' }, NOW).executionBudget).toEqual({
      kind: 'call',
      target: '0x865054F0F6A288adaAc30261731361EA7E908003',
      function: 'function create((string name,string symbol,string tokenURI,uint256 amountOut,bytes32 salt,uint8 actionId) params) payable',
      cap: '12',
    })
  })

  it('sends request_quotes the accepted tokens and when quoting closes, with no price', () => {
    const f = { ...initialForm({ mode: 'quotes' }, tokens, false), title: 'T', brief: 'B', stack: 'demo' as const }
    expect(requestQuotesArgs(f, NOW)).toEqual({
      title: 'T',
      brief: 'B',
      acceptanceCriteria: ['A GitHub check run named "test" completes with conclusion "success" on the submitted SHA.'],
      tokens: [MUSD, MEUR],
      creatorBond: '2',
      workerBond: '1',
      deliveryDeadline: NOW + 48 * 3600,
      quoteDeadline: NOW + 6 * 3600,
      requiredChecks: ['test'],
      stack: 'demo',
    })
  })

  it('a frozen offer is reused only while the form is unchanged', () => {
    const f = { ...initialForm({}, tokens, false), title: 'T', brief: 'B' }
    expect(fingerprint(f)).toBe(fingerprint({ ...f }))
    expect(fingerprint(f)).not.toBe(fingerprint({ ...f, reward: '11' }))
    expect(prefillKey({ title: 'T', worker: '0x1' })).toBe(prefillKey({ title: 'T' }))
  })

  it('says what stops a step', () => {
    const f = initialForm({}, tokens, false)
    expect(stepProblem(f, 1)).toBe('Give the job a title.')
    expect(stepProblem({ ...f, title: 'T', brief: 'B' }, 1)).toBeNull()
    expect(stepProblem({ ...f, reward: '0' }, 3)).toBe('Set a reward above zero.')
    expect(stepProblem({ ...f, mode: 'contest', selectionHours: '60' }, 3)).toBe('The award must come before the delivery deadline.')
    expect(stepProblem({ ...f, mode: 'quotes', quoteTokens: [] }, 3)).toBe('Accept at least one token.')
    expect(stepProblem(f, 3)).toBeNull()
    expect(stepProblem({ ...f, token: 'PET' }, 3)).toMatch(/contract address/)
    expect(stepProblem({ ...f, token: '0x00000000000000000000000000000000000c40a1' }, 3)).toMatch(/decimals from the chain/)
    // An unlisted token needs a stack whose Holding takes any ERC-20; testnet's demo pair predates that.
    expect(stepProblem({ ...f, stack: 'demo' }, 3)).toMatch(/only listed tokens/)
  })

  it('reads amounts and spans as people do', () => {
    expect(humanAmount('1000.50', 'mUSD')).toBe('1,000.5 mUSD')
    expect(humanAmount('abc', 'mUSD')).toBe('abc mUSD')
    expect([hoursText('24'), hoursText('48'), hoursText('168'), hoursText('36'), hoursText('1')]).toEqual(['1 day', '2 days', '1 week', '36 hours', '1 hour'])
  })
})

describe('Hire again', () => {
  const task: TaskIndexEntry = {
    taskId: 't1', jobId: '58', stack: 'main-v2', title: 'Fix the flaky test', brief: 'It fails one run in ten.', acceptanceCriteria: ['CI is green', 'No retries added'],
    mode: 'hire', token: MEUR, reward: '12500000', creatorBond: '2000000000000000000', workerBond: '1500000000000000000',
    creator: MUSD, approver: MUSD, deliveryDeadline: NOW + 72 * 3600, selectionDeadline: null, requiredChecks: ['ci'], quoted: true,
    executionBudget: { kind: 'advance', token: MUSD, cap: '3000000', expiresAt: NOW + 72 * 3600 }, deliverable: { accepts: ['git', 'url'], target: 'https://example.test' },
    termsHash: '0x01', manifestUrl: '/offers/0x01.json', screening: { verdict: 'clean', reasons: [] }, createdAt: NOW,
  }
  const worker = '0x3333333333333333333333333333333333333333'

  it('prefills a direct hire of the same agent with the same token, reward and terms', () => {
    const prefill = hireAgainPrefill({ jobId: '58', agentId: '7001', worker, task, decimals: 6 })
    expect(prefill).toMatchObject({ mode: 'hire', again: '58', agentId: '7001', worker, token: MEUR, reward: '12.5', creatorBond: '2', workerBond: '1.5', deliveryHours: '72', stack: 'main', budget: 'advance', budgetCap: '3' })
    const f = initialForm(prefill, tokens, false)
    expect(f).toMatchObject({ mode: 'hire', title: task.title, brief: task.brief, criteria: 'CI is green\nNo retries added', token: MEUR, reward: '12.5', check: 'ci', accepts: ['git', 'url'], target: 'https://example.test', stack: 'main', budgetOn: true, budgetKind: 'advance', budgetToken: MUSD, budgetCap: '3' })
    const args = createTaskArgs(f, NOW)
    expect(args).toMatchObject({ mode: 'hire', reward: '12.5', creatorBond: '2', workerBond: '1.5', deliveryDeadline: NOW + 72 * 3600, acceptanceCriteria: ['CI is green', 'No retries added'], requiredChecks: ['ci'], deliverable: { accepts: ['git', 'url'], target: 'https://example.test' }, executionBudget: { kind: 'advance', token: MUSD, cap: '3' }, stack: 'main' })
    expect(stepProblem(f, 3)).toBeNull()
    // Another past job, or none, is a different prefill: its draft starts afresh.
    expect(prefillKey(prefill)).not.toBe(prefillKey({ ...prefill, again: '59' }))
  })

  it('keeps an offer without criteria, check or budget that way', () => {
    const { deliverable: _, ...bare } = task
    const f = initialForm(hireAgainPrefill({ jobId: '1', agentId: '2', worker, task: { ...bare, acceptanceCriteria: [], requiredChecks: [], executionBudget: null }, decimals: 6 }), tokens, false)
    expect(f).toMatchObject({ criteria: '', check: '', accepts: ['git'], target: '', budgetOn: false })
    expect(createTaskArgs(f, NOW)).not.toHaveProperty('requiredChecks')
    expect(createTaskArgs(f, NOW)).not.toHaveProperty('executionBudget')
  })
})

describe('direct hire', () => {
  const base = { ...initialForm({ agentId: '1942' }, tokens, false), title: 'T', brief: 'B' }
  it('names the agent only to a v1 board', () => {
    expect(base.invite).toBe('1942')
    expect(createTaskArgs(base, NOW, true)).toMatchObject({ mode: 'hire', invite: { agentId: '1942' } })
    expect(createTaskArgs(base, NOW, false)).not.toHaveProperty('invite')
    expect(createTaskArgs({ ...base, invite: '' }, NOW, true)).not.toHaveProperty('invite')
  })
  it('wants an agent number in digits', () => {
    expect(stepProblem({ ...base, invite: 'abc' }, 2)).toBe('An agent number is digits, like 1942.')
    expect(stepProblem({ ...base, invite: '' }, 2)).toBeNull()
    expect(initialForm({ agentId: 'x1' }, tokens, false).invite).toBe('')
  })
})

describe('v1 windows and arbitrator', () => {
  const H = 3600
  const bounds = { review: [H, 14 * 86400], dispute: [H, 14 * 86400], arbitration: [12 * H, 14 * 86400] } as const
  const me = '0x4444444444444444444444444444444444444444'
  const f = { ...initialForm({}, tokens, false), title: 'T', brief: 'B' }
  it('sends the preset or custom windows, and a custom arbitrator, only to a v1 board', () => {
    expect(windowsOf({ ...f, windowPreset: 'fast' })).toEqual({ reviewSeconds: H, disputeSeconds: H, arbitrationSeconds: 12 * H })
    expect(windowsOf({ ...f, windowPreset: 'long' })).toEqual({ reviewSeconds: 72 * H, disputeSeconds: 72 * H, arbitrationSeconds: 168 * H })
    expect(createTaskArgs(f, NOW, true)).toMatchObject({ windows: { reviewSeconds: 24 * H, disputeSeconds: 24 * H, arbitrationSeconds: 48 * H } })
    expect(createTaskArgs(f, NOW, true)).not.toHaveProperty('arbitrator')
    expect(createTaskArgs({ ...f, arbitrator: MEUR }, NOW, true)).toMatchObject({ arbitrator: MEUR })
    expect(createTaskArgs({ ...f, arbitrator: MEUR }, NOW, false)).not.toHaveProperty('windows')
    expect(createTaskArgs({ ...f, arbitrator: MEUR }, NOW, false)).not.toHaveProperty('arbitrator')
  })
  it('refuses what publish would refuse', () => {
    expect(v1TermsProblem(f, null, me)).toMatch(/Reading the window limits/)
    expect(v1TermsProblem(f, bounds, me)).toBeNull()
    expect(v1TermsProblem({ ...f, windowPreset: 'custom', reviewHours: '0.5', disputeHours: '24', arbitrationHours: '48' }, bounds, me)).toBe('The review window must be between 1 hour and 14 days.')
    expect(v1TermsProblem({ ...f, windowPreset: 'custom', reviewHours: '24', disputeHours: '24', arbitrationHours: '6' }, bounds, me)).toBe('The arbitration window must be between 12 hours and 14 days.')
    expect(v1TermsProblem({ ...f, windowPreset: 'custom', reviewHours: '24', disputeHours: '400', arbitrationHours: '48' }, bounds, me)).toMatch(/dispute window/)
    expect(v1TermsProblem({ ...f, arbitrator: me.toUpperCase().replace('0X', '0x') }, bounds, me)).toMatch(/cannot arbitrate your own job/)
    expect(v1TermsProblem({ ...f, arbitrator: '0x12' }, bounds, me)).toMatch(/arbitrator’s address/)
  })
})
