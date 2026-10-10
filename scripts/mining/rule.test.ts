import { expect, test } from 'bun:test'
import { creditRuleOf, V2_RULE } from './rule.ts'

test('an absent cutover uses v1 forever', () => {
  for (const config of [{}, { mining: {} }]) expect(creditRuleOf(config, 1000000n)).toEqual({ version: 1 })
})

test('the configured epoch is the first v2 epoch, including epoch zero', () => {
  const config = { mining: { creditRule: { fromEpoch: '30' } } }
  expect(creditRuleOf(config, 29n)).toEqual({ version: 1 })
  expect(creditRuleOf(config, 30n)).toEqual({ ...V2_RULE, fromEpoch: 30n })
  expect(creditRuleOf({ mining: { creditRule: { fromEpoch: 0 } } }, 0n).version).toBe(2)
  expect(creditRuleOf({ mining: { creditRule: { fromEpoch: 30n } } }, 31n).version).toBe(2)
})

test('invalid cutover values refuse', () => {
  for (const fromEpoch of ['-1', '', '1.5', 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => creditRuleOf({ mining: { creditRule: { fromEpoch } } }, 100n)).toThrow('nonnegative integer')
})
