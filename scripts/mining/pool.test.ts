import { expect, test } from 'bun:test'
import { concentratedMidPrice, SIDE_PRICE_FLOOR, hourlyBoundaries, reserveMidPrice, selectFactoryPrice } from './pool.ts'
import { officialPoolId, officialPoolOf } from './pool-chain.ts'
import { privateKeyToAccount, type Address } from './viem.ts'
import { PRICE_LIST_TYPES, priceListDomain, typedMessage, verifiedPriceList } from './prices.ts'

test('short first epoch samples 72 hours; timestamps are UTC boundaries and the end is exclusive', () => {
  expect(hourlyBoundaries(0n, 72n * 3600n)).toHaveLength(72)
  expect(hourlyBoundaries(1n, 7200n)).toEqual([3600n])
  expect(hourlyBoundaries(100n, 200n)).toEqual([])
})

test('constant-product mid prices normalize token decimals and round conservatively up', () => {
  const price = reserveMidPrice(10_000n * 10n ** 18n, 2n * 10n ** 6n, 6, 10n ** 18n)
  expect(price.factoryUsdPrice).toBe(2n * SIDE_PRICE_FLOOR)
  expect(reserveMidPrice(3n * 10n ** 18n, 1_000_000n, 6, 10n ** 18n).factoryUsdPrice).toBe(333333333333333334n)
  expect(() => reserveMidPrice(0n, 1n, 6, 10n ** 18n)).toThrow('liquidity')
})

test('concentrated pool prices handle both currency orders and retain virtual reserves', () => {
  const q96 = 1n << 96n
  const first = concentratedMidPrice(2n * q96, 10n ** 18n, true, 18, 10n ** 18n)
  expect(first.factoryUsdPrice).toBe(4n * 10n ** 18n)
  expect(first.factoryReserve).toBe(5n * 10n ** 17n)
  expect(first.quoteReserve).toBe(2n * 10n ** 18n)
  const second = concentratedMidPrice(2n * q96, 10n ** 18n, false, 18, 10n ** 18n)
  expect(second.factoryUsdPrice).toBe(25n * 10n ** 16n)
  expect(second.factoryReserve).toBe(first.quoteReserve)
  expect(() => concentratedMidPrice(1n, 0n, true, 6, 1n)).toThrow('liquidity')
})

test('highest available sample wins, with the floor; a previous price does not replace available hours', () => {
  expect(selectFactoryPrice(2n, [SIDE_PRICE_FLOOR * 2n, SIDE_PRICE_FLOOR * 3n], SIDE_PRICE_FLOOR * 10n))
    .toEqual({ factoryUsdPrice: SIDE_PRICE_FLOOR * 3n, source: 'highest-hourly-sample' })
  expect(selectFactoryPrice(2n, [1n]).factoryUsdPrice).toBe(SIDE_PRICE_FLOOR)
})

test('no hourly samples use previous signed price, or the floor for epoch zero only', () => {
  expect(selectFactoryPrice(0n, [])).toEqual({ factoryUsdPrice: SIDE_PRICE_FLOOR, source: 'epoch-zero-floor' })
  expect(selectFactoryPrice(1n, [], 2n * SIDE_PRICE_FLOOR)).toEqual({ factoryUsdPrice: 2n * SIDE_PRICE_FLOOR, source: 'previous-signed-price' })
  expect(selectFactoryPrice(1n, [], 1n).factoryUsdPrice).toBe(SIDE_PRICE_FLOOR)
  expect(() => selectFactoryPrice(1n, [])).toThrow('previous epoch')
})

test('an absent official venue is explicit and invalid config refuses', () => {
  expect(officialPoolOf({})).toBeNull()
  expect(() => officialPoolOf({ mining: { officialPool: { kind: 'arbitrary-url' } } })).toThrow('unsupported')
  const pool = officialPoolOf({ mining: { officialPool: {
    kind: 'uniswap-v4', poolManager: `0x${'1'.repeat(40)}`, stateView: `0x${'2'.repeat(40)}`,
    quoteToken: `0x${'3'.repeat(40)}`, fee: 3000, tickSpacing: 60, hooks: `0x${'0'.repeat(40)}`,
  } } })
  if (pool?.kind !== 'uniswap-v4') throw new Error('fixture pool missing')
  expect(officialPoolId(pool, `0x${'4'.repeat(40)}`)).toMatch(/^0x[0-9a-f]{64}$/)
  expect(officialPoolId(pool, `0x${'4'.repeat(40)}`)).not.toBe(officialPoolId({ ...pool, fee: 500 }, `0x${'4'.repeat(40)}`))
})

test('a fallback price must carry a current Safe owner signature for the exact prior epoch and domain', async () => {
  const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d') // anvil dev key
  const distributor = `0x${'1'.repeat(40)}` as Address
  const prices = { epoch: 0n, tokens: [], factoryUsdPrice: SIDE_PRICE_FLOOR }
  const signature = await owner.signTypedData({ domain: priceListDomain(10143, distributor), types: PRICE_LIST_TYPES, primaryType: 'PriceList', message: typedMessage(prices) })
  const file = { message: { epoch: '0', tokens: [], factoryUsdPrice: prices.factoryUsdPrice.toString() }, signature }
  const expected = { epoch: 0n, chainId: 10143, distributor, owners: [owner.address] }
  expect((await verifiedPriceList(file, expected)).prices.factoryUsdPrice).toBe(SIDE_PRICE_FLOOR)
  await expect(verifiedPriceList(file, { ...expected, epoch: 1n })).rejects.toThrow('wrong epoch')
  await expect(verifiedPriceList(file, { ...expected, chainId: 143 })).rejects.toThrow('Safe owner')
  await expect(verifiedPriceList(file, { ...expected, owners: [] })).rejects.toThrow('Safe owner')
  await expect(verifiedPriceList({ ...file, message: { ...file.message, factoryUsdPrice: '1' } }, expected)).rejects.toThrow('Safe owner')
})
