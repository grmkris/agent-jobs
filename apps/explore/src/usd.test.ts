import { describe, expect, it } from 'vitest'
import { approxUsd, isUsdPegged, usdPerUnit, usdValue } from './usd.ts'
import { deployment } from './wallet.ts'

const [musd, meur] = deployment.rewardTokens

describe('wallet dollar estimates', () => {
  it('pegs only what the network config lists', () => {
    expect(isUsdPegged(musd!)).toBe(true)
    expect(isUsdPegged(musd!.toUpperCase().replace('0X', '0x'))).toBe(true)
    expect(isUsdPegged(meur!)).toBe(false)
    expect(isUsdPegged(deployment.factory)).toBe(false)
  })

  it('prices SIDE only through a live pool price, and nothing else without a source', () => {
    expect(usdPerUnit(musd!, undefined)).toBe(1)
    expect(usdPerUnit(deployment.factory, 0.084)).toBe(0.084)
    expect(usdPerUnit(deployment.factory, undefined)).toBeUndefined()
    expect(usdPerUnit(meur!, 0.084)).toBeUndefined()
    expect(usdPerUnit(null, 0.084)).toBeUndefined()
  })

  it('values a balance in whole tokens and never invents one', () => {
    expect(usdValue(2_500_000n, 6, 1)).toBe(2.5)
    expect(usdValue(500n * 10n ** 18n, 18, 0.084)).toBeCloseTo(42)
    expect(usdValue(undefined, 6, 1)).toBeUndefined()
    expect(usdValue(1n, 6, undefined)).toBeUndefined()
  })

  it('reads as an estimate, except an empty balance', () => {
    expect(approxUsd(0)).toBe('$0')
    expect(approxUsd(0.004)).toBe('≈ <$0.01')
    expect(approxUsd(12.4)).toBe('≈ $12.40')
    expect(approxUsd(999.994)).toBe('≈ $999.99')
    expect(approxUsd(1240.4)).toBe('≈ $1,240')
  })
})
