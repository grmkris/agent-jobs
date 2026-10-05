import { decimalsOf, firstBlockAtOrAfter } from './chain.ts'
import { concentratedMidPrice, hourlyBoundaries, reserveMidPrice } from './pool.ts'
import type { PriceList } from './prices.ts'
import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex, type PublicClient } from './viem.ts'

export type OfficialPool = {
  kind: 'constant-product'
  address: Address
  quoteToken: Address
} | {
  kind: 'uniswap-v4'
  poolManager: Address
  stateView: Address
  quoteToken: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

/** The venue remains a coordinator decision. No liquidity recipe is silently promoted to the official pool. */
export function officialPoolOf(config: { mining?: { officialPool?: unknown } }): OfficialPool | null {
  const raw = config.mining?.officialPool
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid official mining pool config')
  const pool = raw as Record<string, unknown>
  const address = (field: string): Address => {
    const value = pool[field]
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) throw new Error(`invalid mining pool ${field}`)
    return value.toLowerCase() as Address
  }
  if (pool.kind === 'constant-product') return { kind: pool.kind, address: address('address'), quoteToken: address('quoteToken') }
  if (pool.kind !== 'uniswap-v4') throw new Error('unsupported official mining pool venue')
  const fee = pool.fee
  const tickSpacing = pool.tickSpacing
  const hooks = pool.hooks
  if (typeof fee !== 'number' || !Number.isInteger(fee) || fee < 0 || fee > 1_000_000
    || typeof tickSpacing !== 'number' || !Number.isInteger(tickSpacing) || tickSpacing <= 0 || tickSpacing > 8388607
    || typeof hooks !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(hooks)) throw new Error('invalid official mining pool key')
  return { kind: pool.kind, poolManager: address('poolManager'), stateView: address('stateView'), quoteToken: address('quoteToken'), fee, tickSpacing, hooks: hooks.toLowerCase() as Address }
}

const pairAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
])
const stateViewAbi = parseAbi([
  'function poolManager() view returns (address)',
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
])

export function officialPoolId(pool: Extract<OfficialPool, { kind: 'uniswap-v4' }>, factory: Address): Hex {
  const currencies = [factory.toLowerCase(), pool.quoteToken].toSorted() as [Address, Address]
  return keccak256(encodeAbiParameters([
    { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' },
  ], [...currencies, pool.fee, pool.tickSpacing, pool.hooks]))
}

interface SamplePosition {
  boundary: string
  block: string
  blockHash: Hex
  timestamp: string
}

export type HourlySample = SamplePosition & {
  status: 'sampled'
  reservesKind: 'raw' | 'virtual-active-liquidity'
  factoryReserve: string
  quoteReserve: string
  factoryUsdPrice: string
  sqrtPriceX96?: string
  liquidity?: string
} | {
  boundary: string
  status: 'missing'
  reason: 'official-pool-unconfigured' | 'quote-token-unpriced' | 'historical-read-unavailable' | 'no-block-in-epoch'
}

/** Reads the first block at/after every UTC hour boundary, never a nearby substitute or caller-supplied reserve. */
export async function sampleOfficialPool(input: {
  c: PublicClient
  pool: OfficialPool | null
  factory: Address
  prices: PriceList
  start: bigint
  end: bigint
  fromBlock: bigint
  toBlock: bigint
}) {
  const { c, pool, factory, prices, start, end, fromBlock, toBlock } = input
  const boundaries = hourlyBoundaries(start, end)
  const quote = pool === null ? undefined : prices.tokens.find(token => token.token === pool.quoteToken)
  const samples: HourlySample[] = []
  if (pool !== null) {
    if (pool.quoteToken === factory.toLowerCase()) throw new Error('official pool quote is FACTORY')
    // Configuration mismatches refuse the run; ordinary missing historical reads use the documented fallback.
    if (await decimalsOf(c, factory) !== 18) throw new Error('FACTORY must have 18 decimals')
    if (pool.kind === 'constant-product') {
      const [token0, token1] = await Promise.all([
        c.readContract({ address: pool.address, abi: pairAbi, functionName: 'token0' }),
        c.readContract({ address: pool.address, abi: pairAbi, functionName: 'token1' }),
      ])
      const actual = [token0.toLowerCase(), token1.toLowerCase()].toSorted()
      const expected = [factory.toLowerCase(), pool.quoteToken].toSorted()
      if (actual.some((token, index) => token !== expected[index])) throw new Error('official pool currencies differ from config')
      if (token0.toLowerCase() !== expected[0]) throw new Error('official constant-product pool has noncanonical currency order')
    } else {
      const manager = await c.readContract({ address: pool.stateView, abi: stateViewAbi, functionName: 'poolManager' })
      if (manager.toLowerCase() !== pool.poolManager) throw new Error('official pool stateView manager differs from config')
    }
  }
  for (const boundary of boundaries) {
    if (pool === null || quote === undefined) {
      samples.push({ boundary: boundary.toString(), status: 'missing', reason: pool === null ? 'official-pool-unconfigured' : 'quote-token-unpriced' })
      continue
    }
    try {
      const blockNumber = await firstBlockAtOrAfter(c, boundary, fromBlock, toBlock)
      if (blockNumber > toBlock) {
        samples.push({ boundary: boundary.toString(), status: 'missing', reason: 'no-block-in-epoch' })
        continue
      }
      const block = await c.getBlock({ blockNumber })
      const position = { boundary: boundary.toString(), block: blockNumber.toString(), blockHash: block.hash!, timestamp: block.timestamp.toString() }
      const factoryFirst = factory.toLowerCase() < pool.quoteToken
      if (pool.kind === 'constant-product') {
        const [reserve0, reserve1] = await c.readContract({ address: pool.address, abi: pairAbi, functionName: 'getReserves', blockNumber })
        const mid = reserveMidPrice(factoryFirst ? reserve0 : reserve1, factoryFirst ? reserve1 : reserve0, quote.decimals, quote.usdPrice)
        samples.push({ ...position, status: 'sampled', reservesKind: 'raw', factoryReserve: mid.factoryReserve.toString(), quoteReserve: mid.quoteReserve.toString(), factoryUsdPrice: mid.factoryUsdPrice.toString() })
      } else {
        const poolId = officialPoolId(pool, factory)
        const [slot0, liquidity] = await Promise.all([
          c.readContract({ address: pool.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [poolId], blockNumber }),
          c.readContract({ address: pool.stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [poolId], blockNumber }),
        ])
        const mid = concentratedMidPrice(slot0[0], liquidity, factoryFirst, quote.decimals, quote.usdPrice)
        samples.push({ ...position, status: 'sampled', reservesKind: 'virtual-active-liquidity', factoryReserve: mid.factoryReserve.toString(), quoteReserve: mid.quoteReserve.toString(), factoryUsdPrice: mid.factoryUsdPrice.toString(), sqrtPriceX96: slot0[0].toString(), liquidity: liquidity.toString() })
      }
    } catch {
      samples.push({ boundary: boundary.toString(), status: 'missing', reason: 'historical-read-unavailable' })
    }
  }
  return {
    pool, poolId: pool?.kind === 'uniswap-v4' ? officialPoolId(pool, factory) : null,
    quote: quote === undefined ? null : { token: quote.token, decimals: quote.decimals, usdPrice: quote.usdPrice.toString() }, samples,
  }
}
