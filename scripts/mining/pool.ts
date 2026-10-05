/** USD prices have 18 decimals; all ratios round up so truncation never increases emission. */
export const FACTORY_PRICE_FLOOR = 10n ** 14n
export const HOUR = 3600n

export interface MidPrice {
  factoryUsdPrice: bigint
  factoryReserve: bigint
  quoteReserve: bigint
}

function ceilingRatio(numerator: bigint, denominator: bigint): bigint {
  if (numerator <= 0n || denominator <= 0n) throw new Error('pool has no positive price or liquidity')
  return (numerator + denominator - 1n) / denominator
}

function checkQuote(decimals: number, usdPrice: bigint): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || usdPrice <= 0n) throw new Error('invalid pool quote price')
}

/** Constant-product raw reserves, FACTORY always 18 decimals. */
export function reserveMidPrice(factoryReserve: bigint, quoteReserve: bigint, quoteDecimals: number, quoteUsdPrice: bigint): MidPrice {
  checkQuote(quoteDecimals, quoteUsdPrice)
  const factoryUsdPrice = ceilingRatio(quoteReserve * 10n ** 18n * quoteUsdPrice, factoryReserve * 10n ** BigInt(quoteDecimals))
  return { factoryUsdPrice, factoryReserve, quoteReserve }
}

/** Concentrated-liquidity mid price and virtual reserves. These reserves describe active liquidity, not token balances. */
export function concentratedMidPrice(sqrtPriceX96: bigint, liquidity: bigint, factoryFirst: boolean, quoteDecimals: number, quoteUsdPrice: bigint): MidPrice {
  checkQuote(quoteDecimals, quoteUsdPrice)
  if (sqrtPriceX96 <= 0n || liquidity <= 0n) throw new Error('pool has no positive price or liquidity')
  const q96 = 1n << 96n
  const reserve0 = liquidity * q96 / sqrtPriceX96
  const reserve1 = liquidity * sqrtPriceX96 / q96
  const ratioNumerator = factoryFirst ? sqrtPriceX96 ** 2n : q96 ** 2n
  const ratioDenominator = factoryFirst ? q96 ** 2n : sqrtPriceX96 ** 2n
  return {
    factoryUsdPrice: ceilingRatio(ratioNumerator * 10n ** 18n * quoteUsdPrice, ratioDenominator * 10n ** BigInt(quoteDecimals)),
    factoryReserve: factoryFirst ? reserve0 : reserve1,
    quoteReserve: factoryFirst ? reserve1 : reserve0,
  }
}

/** UTC hour boundaries within [start,end); fast testnet epochs can have no boundaries. */
export function hourlyBoundaries(start: bigint, end: bigint): bigint[] {
  if (start < 0n || end <= start) throw new Error('invalid sampling window')
  const boundaries: bigint[] = []
  for (let boundary = ((start + HOUR - 1n) / HOUR) * HOUR; boundary < end; boundary += HOUR) boundaries.push(boundary)
  return boundaries
}

export interface PriceSelection {
  factoryUsdPrice: bigint
  source: 'highest-hourly-sample' | 'previous-signed-price' | 'epoch-zero-floor'
}

/** Missing hours never replace existing samples. No samples require the immediately previous signed epoch price. */
export function selectFactoryPrice(epoch: bigint, samples: readonly bigint[], previousSignedPrice?: bigint): PriceSelection {
  if (epoch < 0n || samples.some(price => price <= 0n)) throw new Error('invalid factory price inputs')
  let highest = FACTORY_PRICE_FLOOR
  for (const price of samples) if (price > highest) highest = price
  if (samples.length > 0) return { factoryUsdPrice: highest, source: 'highest-hourly-sample' }
  if (epoch === 0n) return { factoryUsdPrice: FACTORY_PRICE_FLOOR, source: 'epoch-zero-floor' }
  if (previousSignedPrice === undefined || previousSignedPrice <= 0n) throw new Error('no pool samples: previous epoch signed price is required')
  return {
    factoryUsdPrice: previousSignedPrice > FACTORY_PRICE_FLOOR ? previousSignedPrice : FACTORY_PRICE_FLOOR,
    source: 'previous-signed-price',
  }
}
