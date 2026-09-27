import { describe, expect, it } from 'vitest'
import { quoteRequestFromDispatch } from './dispatch.ts'

const task = {
  id: 't000007',
  title: 'Roman numerals both ways',
  description: 'Implement toRoman and fromRoman per the README.',
  repo: { url: 'https://github.com/grmkris/aj-bounty-roman', baseCommit: 'e006fa8' },
  acceptance: ['The existing tests are unchanged.'],
}
const policy = { tokens: ['mUSD', 'mEUR'], creatorBond: '2', workerBond: '1', deliveryHours: 3, quoteHours: 0.5, requiredChecks: ['test'], stack: 'main' as const }

describe('Dispatch adapter', () => {
  it('maps a Dispatch task to a quote request with the repo, base commit and required check', () => {
    const r = quoteRequestFromDispatch(task, policy, 1_000)
    expect(r.title).toBe('Roman numerals both ways')
    expect(r.brief).toContain('https://github.com/grmkris/aj-bounty-roman (branch from commit e006fa8)')
    expect(r.brief).toContain('task t000007')
    expect(r.acceptanceCriteria).toEqual([
      'A GitHub check run named "test" completes with conclusion "success" on the submitted SHA.',
      'The existing tests are unchanged.',
    ])
    expect(r).toMatchObject({ tokens: ['mUSD', 'mEUR'], deliveryDeadline: 1_000 + 3 * 3600, quoteDeadline: 1_000 + 1800, requiredChecks: ['test'], stack: 'main' })
  })

  it('refuses a non-GitHub repo and quotes that would close after delivery', () => {
    expect(() => quoteRequestFromDispatch({ ...task, repo: { url: 'https://gitlab.com/a/b' } }, policy, 0)).toThrow('public GitHub')
    expect(() => quoteRequestFromDispatch(task, { ...policy, quoteHours: 3 }, 0)).toThrow('before the delivery deadline')
  })
})
