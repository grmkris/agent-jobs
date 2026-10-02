import { expect, it } from 'vitest'
import { positiveAmount } from './v1-tools.ts'

const fail = (_code: string, message: string) => new Error(message)
it('amounts are exact base units and never rounded, signed, exponential, zero or overflowing', () => {
  expect(positiveAmount('1.000001', 6, fail)).toBe(1_000_001n)
  for (const amount of ['1.0000001', '-1', '+1', '1e6', '.1', '1.', ' 1', '0', '0.000000', (1n << 256n).toString()])
    expect(() => positiveAmount(amount, 6, fail), amount).toThrow()
})
