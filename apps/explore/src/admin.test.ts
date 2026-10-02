import { describe, expect, it } from 'vitest'
import { bpsOf, resizeProblem, rootProblem, scheduleProposal } from './admin.ts'

const treasury = '0x9999999999999999999999999999999999999999'
const ok = { thresholds: ['0', '10000', '100000', '1000000'], rates: ['30', '10', '3', '1'], treasury }
const W = 10n ** 18n

describe('a fee schedule proposal', () => {
  it('becomes exactly what propose takes', () => {
    expect(scheduleProposal(ok, 3000)).toEqual({ thresholds: [0n, 10_000n * W, 100_000n * W, 1_000_000n * W], bps: [3000, 1000, 300, 100], treasury })
    expect(bpsOf('2.5')).toBe(250)
    expect(bpsOf('2.555')).toBeNull()
  })
  it('is refused for what the contract refuses, before anything is signed', () => {
    expect(scheduleProposal({ ...ok, thresholds: ['1', '10000', '100000', '1000000'] }, 3000)).toMatch(/start at 0/)
    expect(scheduleProposal({ ...ok, thresholds: ['0', '10000', '10000', '1000000'] }, 3000)).toMatch(/above the one before/)
    expect(scheduleProposal({ ...ok, rates: ['31', '10', '3', '1'] }, 3000)).toMatch(/more than 30 %/)
    expect(scheduleProposal({ ...ok, rates: ['30', '10', '12', '1'] }, 3000)).toMatch(/higher fee/)
    expect(scheduleProposal({ ...ok, treasury: '0x0000000000000000000000000000000000000000' }, 3000)).toMatch(/treasury/)
    expect(scheduleProposal({ ...ok, rates: ['30', 'x', '3', '1'] }, 3000)).toMatch(/Tier 2/)
  })
})

describe('an epoch root', () => {
  it('needs an epoch, a root, a total and a data hash', () => {
    const h = `0x${'ab'.repeat(32)}`
    expect(rootProblem({ epoch: '0', root: h, total: '1000', dataHash: h })).toBeNull()
    expect(rootProblem({ epoch: '', root: h, total: '1000', dataHash: h })).toMatch(/epoch/)
    expect(rootProblem({ epoch: '0', root: '0x12', total: '1000', dataHash: h })).toMatch(/root/)
    expect(rootProblem({ epoch: '0', root: h, total: '0', dataHash: h })).toMatch(/total/)
  })
})

describe('resizing a posted root', () => {
  const root = { total: 5000n * 10n ** 18n, claimed: 1000n * 10n ** 18n }
  it('shrinks to the leaf sum, never below what is claimed', () => {
    expect(resizeProblem('4200', root)).toBeNull()
    expect(resizeProblem('1000', root)).toBeNull()
    expect(resizeProblem('999.9', root)).toMatch(/already been claimed/)
    expect(resizeProblem('5000', root)).toMatch(/below the posted/)
    expect(resizeProblem('6000', root)).toMatch(/below the posted/)
    expect(resizeProblem('', root)).toMatch(/Enter the new total/)
    expect(resizeProblem('x', root)).toMatch(/Enter the new total/)
    expect(resizeProblem('0', { total: root.total, claimed: 0n })).toBeNull()
  })
})
