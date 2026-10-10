import { expect, test } from 'bun:test'
import { checkPriceRule, type PriceList } from './prices.ts'

const factory = '0x0000000000000000000000000000000000000001'
const usdc = '0x0000000000000000000000000000000000000002'
const other = '0x0000000000000000000000000000000000000003'
const dollar = 10n ** 18n
const tolerance = 10n ** 16n
const options = { factory, factoryUsdPrice: 10n ** 14n, network: 'monad-mainnet' as const, usdPegged: [usdc] }
const list = (tokens: PriceList['tokens']): PriceList => ({
  epoch: 30n,
  factoryUsdPrice: options.factoryUsdPrice,
  tokens,
})

test('factory fee-token prices must match the reference exactly and use 18 decimals', () => {
  const token = { token: factory, decimals: 18, usdPrice: options.factoryUsdPrice }
  expect(() => checkPriceRule(list([token]), options)).not.toThrow()
  for (const patch of [
    { decimals: 6 },
    { usdPrice: options.factoryUsdPrice + 1n },
    { usdPrice: options.factoryUsdPrice - 1n },
  ])
    expect(() => checkPriceRule(list([{ ...token, ...patch }]), options)).toThrow('factory fee token')
})

test('mainnet refuses tokens outside usdPegged, even when priced at one dollar', () => {
  expect(() => checkPriceRule(list([{ token: other, decimals: 6, usdPrice: dollar }]), options)).toThrow(
    'not configured',
  )
})

test('mainnet accepts the inclusive one-percent peg boundaries and refuses one wei outside', () => {
  for (const usdPrice of [dollar, dollar - tolerance, dollar + tolerance])
    expect(() => checkPriceRule(list([{ token: usdc, decimals: 6, usdPrice }]), options)).not.toThrow()
  for (const usdPrice of [dollar - tolerance - 1n, dollar + tolerance + 1n])
    expect(() => checkPriceRule(list([{ token: usdc, decimals: 6, usdPrice }]), options)).toThrow('USD peg')
})

test('testnet permits nonpegged fee tokens while still checking the factory price', () => {
  const testnet = { ...options, network: 'monad-testnet' as const }
  expect(() => checkPriceRule(list([{ token: other, decimals: 8, usdPrice: 42n * dollar }]), testnet)).not.toThrow()
  expect(() => checkPriceRule(list([{ token: factory, decimals: 18, usdPrice: dollar }]), testnet)).toThrow(
    'factory fee token',
  )
})
