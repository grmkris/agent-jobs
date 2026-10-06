import { describe, expect, it } from 'vitest'
import { firstSide, isNew, moneyLines, success, tierProgress } from './agent-stats.ts'
import { registerTokens } from './format.ts'

const six = '0x00000000000000000000000000000000000000a6'
const eighteen = '0x00000000000000000000000000000000000000b8'
registerTokens([{ address: six, symbol: 'SIX', decimals: 6 }, { address: eighteen, symbol: 'EIGHTEEN', decimals: 18 }])

describe('agent profile numbers', () => {
  it('counts success over settled jobs only, and shows a rate from the third', () => {
    expect(success({ completed: 2, lost: 0 })).toEqual({ settled: 2, paid: 2, rate: null })
    expect(success({ completed: 11, lost: 1 })).toEqual({ settled: 12, paid: 11, rate: 11 / 12 })
    expect(success({ completed: 0, lost: 0 })).toEqual({ settled: 0, paid: 0, rate: null })
  })

  it('orders money by size across decimals, drops zero totals and counts the rest as "+N more"', () => {
    const totals = {
      [eighteen]: { gross: '2000000000000000000', fee: '0', net: '2000000000000000000' }, // 2
      [six]: { gross: '5000000', fee: '500000', net: '4500000' }, // 5
      '0x00000000000000000000000000000000000000c0': { gross: '0', fee: '0', net: '0' },
    }
    const { lines, more, all } = moneyLines(totals, 1)
    expect(lines.map((l) => l.token)).toEqual([six])
    expect(all.map((l) => l.token)).toEqual([six, eighteen])
    expect(more).toBe(1)
    expect(moneyLines(undefined)).toEqual({ lines: [], all: [], more: 0 })
  })

  it('opens the job list on the side with more jobs', () => {
    expect(firstSide(0, 2)).toBe('posted')
    expect(firstSide(3, 2)).toBe('took')
    expect(firstSide(1, 1)).toBe('took')
  })

  it('measures fee-tier progress from the current threshold to the next', () => {
    const E = 10n ** 18n
    expect(tierProgress(100n * E, { threshold: 0n, nextThreshold: 10_000n * E })).toBe(0.01)
    expect(tierProgress(10_000n * E, { threshold: 10_000n * E, nextThreshold: 100_000n * E })).toBe(0)
    expect(tierProgress(5n, { threshold: 0n, nextThreshold: null })).toBe(1)
    expect(tierProgress(200n, { threshold: 0n, nextThreshold: 100n })).toBe(1)
  })

  it('treats an agent with no taken and no posted job as new', () => {
    expect(isNew(null)).toBe(true)
    expect(isNew({ agent: { jobs: 0 }, hiring: { posted: 0 } })).toBe(true)
    expect(isNew({ agent: { jobs: 0 }, hiring: { posted: 2 } })).toBe(false)
    expect(isNew({ agent: { jobs: 1 } })).toBe(false)
  })
})
