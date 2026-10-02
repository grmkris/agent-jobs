import { describe, expect, it } from 'vitest'
import { PROPOSAL_GRACE, amountProblem, factoryAmount, percent, proposalState, tierOf } from './stake.ts'

const K = 10n ** 18n * 1000n
// The deploy schedule (ADR-0011) as the contract returns it; the page reads it, these tests only fix the arithmetic.
const schedule = { thresholds: [0n, 10n * K, 100n * K, 1000n * K], bps: [3000, 1000, 300, 100] }

describe('fee tiers', () => {
  it('places a stake in the highest tier whose threshold it reaches', () => {
    expect(tierOf(schedule, 0n).current).toEqual({ index: 0, bps: 3000, threshold: 0n })
    expect(tierOf(schedule, 10n * K - 1n).current.bps).toBe(3000)
    expect(tierOf(schedule, 10n * K).current.bps).toBe(1000)
    expect(tierOf(schedule, 999n * K).current.bps).toBe(300)
    expect(tierOf(schedule, 5000n * K).current.bps).toBe(100)
  })
  it('says what the next tier needs, and that there is none past the last', () => {
    expect(tierOf(schedule, 4n * K).next).toEqual({ index: 1, bps: 1000, threshold: 10n * K, needed: 6n * K })
    expect(tierOf(schedule, 1000n * K).next).toBeNull()
  })
  it('follows a retuned schedule rather than the deploy one', () => {
    expect(tierOf({ thresholds: [0n, 5n * K, 50n * K, 500n * K], bps: [2500, 800, 250, 50] }, 6n * K)).toMatchObject({ current: { bps: 800 }, next: { bps: 250, needed: 44n * K } })
  })
  it('writes rates as percentages', () => {
    expect([percent(3000), percent(1000), percent(300), percent(100), percent(250)]).toEqual(['30 %', '10 %', '3 %', '1 %', '2.5 %'])
  })
})

describe('typed amounts', () => {
  it('reads FACTORY in wei and refuses what is not a positive amount', () => {
    expect(factoryAmount('1.5')).toBe(1_500_000_000_000_000_000n)
    expect(factoryAmount('0')).toBeNull()
    expect(factoryAmount('abc')).toBeNull()
    expect(factoryAmount('1.0000000000000000001')).toBeNull()
  })
  it('checks the amount against what the wallet holds or what can be unstaked', () => {
    expect(amountProblem('', 1n, 'stake')).toBeNull()
    expect(amountProblem('2', 10n ** 18n, 'stake')).toBe('That is more FACTORY than your wallet holds.')
    expect(amountProblem('2', 10n ** 18n, 'unstake')).toMatch(/reserved stake stays/)
    expect(amountProblem('1', 10n ** 18n, 'unstake')).toBeNull()
  })
})

describe('timelocked proposals', () => {
  it('wait for their eta, then stay executable for the grace window, then expire', () => {
    const eta = 1_000_000
    expect(PROPOSAL_GRACE).toBe(7 * 86_400)
    expect(proposalState(eta, eta - 1)).toBe('waiting')
    expect(proposalState(eta, eta)).toBe('open')
    expect(proposalState(eta, eta + PROPOSAL_GRACE)).toBe('open')
    expect(proposalState(eta, eta + PROPOSAL_GRACE + 1)).toBe('expired')
  })
})
