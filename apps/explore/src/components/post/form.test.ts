import { describe, expect, it } from 'vitest'
import { registerTokens } from '../../format.ts'
import { createTaskArgs, fingerprint, hoursText, humanAmount, initialForm, prefillKey, requestQuotesArgs, stepProblem } from './form.ts'

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
    const f = initialForm({ title: 'T', brief: 'B', reward: '7', token: 'MEUR', mode: 'contest' }, tokens, false)
    expect(f).toMatchObject({ title: 'T', brief: 'B', reward: '7', token: MEUR, mode: 'contest', creatorBond: '2', workerBond: '1' })
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
