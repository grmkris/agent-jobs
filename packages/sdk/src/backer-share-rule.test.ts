import { expect, test } from 'vitest'
import { encodeBackerShare } from './backer-share.ts'
import { agentWindowShare, walletShare } from './backer-share-rule.ts'

const set = (position: number, bps: number) => ({ position, value: encodeBackerShare(bps) })
const compare = (a: { block: bigint; logIndex: number }, b: { block: bigint; logIndex: number }) =>
  a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1

test('a raise at or inside an epoch applies at the next epoch', () => {
  const sets = [set(2, 1000), set(10, 5000), set(12, 9000)]
  expect(agentWindowShare(sets, 7, 10)).toBe(1000)
  expect(agentWindowShare(sets, 17, 20)).toBe(9000)
})

test('a cut waits until the former share leaves the notice window', () => {
  const sets = [set(2, 8000), set(10, 2000)]
  expect(agentWindowShare(sets, 7, 14)).toBe(8000)
  expect(agentWindowShare(sets, 10, 17)).toBe(8000)
  expect(agentWindowShare(sets, 11, 18)).toBe(2000)
})

test('the last prior value and every set inside the window compete for the maximum', () => {
  const sets = [set(8, 8000), set(1, 10000), set(9, 500), set(3, 1000), set(7, 4000)]
  expect(agentWindowShare(sets, 7, 10)).toBe(8000)
  expect(agentWindowShare([set(1, 10000), set(3, 1000)], 7, 10)).toBe(1000)
})

test('unset and invalid words decode to zero; oversized words cap at 10000', () => {
  expect(agentWindowShare([], 7, 10)).toBe(0)
  expect(agentWindowShare([{ position: 2, value: '0x12' }], 7, 10)).toBe(0)
  expect(agentWindowShare([set(1, 5000), { position: 2, value: '0x' }], 7, 10)).toBe(0)
  expect(agentWindowShare([{ position: 2, value: `0x${'f'.repeat(64)}` }], 7, 10)).toBe(10000)
})

test('timestamps and block/log positions obey the same boundaries', () => {
  expect(agentWindowShare([{ position: 2n, value: encodeBackerShare(3000) }], 7n, 10n)).toBe(3000)
  const sets = [
    { position: { block: 2n, logIndex: 1 }, value: encodeBackerShare(7000) },
    { position: { block: 2n, logIndex: 2 }, value: encodeBackerShare(1000) },
  ]
  expect(agentWindowShare(sets, { block: 2n, logIndex: 3 }, { block: 3n, logIndex: 0 }, compare)).toBe(1000)
  expect(() => agentWindowShare([], 10, 7)).toThrow('after the epoch')
})

test('the wallet maximum prevents the second-ID zero-share dodge', () => {
  const shares = new Map([
    [1n, 7500],
    [2n, 0],
  ])
  expect(walletShare(new Set([1n, 2n]), (id) => shares.get(id) ?? 0)).toBe(7500)
  expect(walletShare([], () => 10000)).toBe(0)
})
