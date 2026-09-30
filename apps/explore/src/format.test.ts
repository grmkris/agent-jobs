import { describe, expect, it } from 'vitest'
import { TOKENS, amount, formatNumber, registerTokens } from './format.ts'

describe('token amount display', () => {
  it('does not guess decimals for unknown tokens', () => {
    expect(amount('5000000', '0x9999999999999999999999999999999999999999')).toBe('— tokens')
  })
  it('keeps the real symbol and decimals after metadata resolution', () => {
    const address = '0x9999999999999999999999999999999999999999'
    registerTokens([{ address, symbol: 'OPEN', decimals: 6 }])
    expect(amount('5000000', address)).toBe('5 OPEN')
  })
  it('does not render positive dust as zero', () => {
    expect(formatNumber(1n, 18)).toBe('<0.0001')
    expect(formatNumber(1n, 6)).toBe('<0.0001')
  })
  it('retains listed metadata', () => {
    expect(Object.keys(TOKENS).length).toBeGreaterThan(0)
  })
})
