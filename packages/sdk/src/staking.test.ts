import { describe, expect, it } from 'vitest'
import { backingOf, positionIn, shareValue, type StakePool } from './staking.ts'

const pool: StakePool = { assets: 101n, reserved: 30n, shares: 100n, queuedShares: 20n, generation: 2n }
const schedule = { thresholds: [0n, 80n, 100n, 1000n], bps: [3000, 1000, 300, 100] }

describe('delegated backing and position arithmetic', () => {
  it('counts all active backing for the tier while queued shares remain part of the pool', () => {
    expect(backingOf(pool, schedule)).toMatchObject({
      assets: 101n,
      active: 80n,
      queued: 20n,
      available: 50n,
      tier: { index: 1, feeBps: 1000, nextThreshold: 100n, needed: 20n },
    })
    expect(backingOf({ ...pool, reserved: 100n }, schedule).available).toBe(0n)
  })

  it('values queued and active shares at the same price after a pro-rata slash', () => {
    const position = { shares: 50n, queuedShares: 10n, unlockAt: 123, generation: 2n }
    expect(positionIn(pool, position)).toMatchObject({
      shares: 50n,
      value: 50n,
      activeValue: 40n,
      queued: 10n,
      shareBps: 5000,
      staleGeneration: false,
    })
    expect(positionIn({ ...pool, assets: 51n }, position)).toMatchObject({ value: 25n, queued: 5n })
    expect(shareValue(pool, pool.shares)).toBe(pool.assets)
  })

  it('never carries old-generation shares into a new pool and labels a normalized zero view honestly', () => {
    const position = { shares: 50n, queuedShares: 10n, unlockAt: 123, generation: 1n }
    expect(positionIn(pool, position)).toMatchObject({
      shares: 0n,
      value: 0n,
      queued: 0n,
      unlockAt: 0,
      staleGeneration: true,
    })
    const normalized = { shares: 0n, queuedShares: 0n, unlockAt: 0, generation: 2n }
    expect(positionIn(pool, normalized).staleGeneration).toBeNull()
    expect(positionIn(pool, normalized, 1n).staleGeneration).toBe(true)
  })

  it('handles inflated share counts with exact integer arithmetic and an empty pool', () => {
    const inflated = { ...pool, assets: 10n ** 27n, shares: (1n << 192n) - 1n, queuedShares: 0n }
    expect(shareValue(inflated, inflated.shares)).toBe(inflated.assets)
    expect(shareValue({ ...pool, shares: 0n, assets: 0n }, 1n)).toBe(0n)
  })
})

// A single fixed block prevents a slash between the position and price reads from changing the approved share intent.
describe('amount-to-share exit preparation', () => {
  it('pins every read, rounds partial exits down, and includes the remainder for a full exit', async () => {
    const { undelegationShares } = await import('./actions.ts')
    const { deployment } = await import('./deployment.ts')
    const d = deployment('monad-testnet')
    const account = d.relay
    const blocks: unknown[] = []
    const ctx = {
      deployment: d,
      stack: d.stacks.main!,
      publicClient: {
        getBlockNumber: async () => 100n,
        readContract: async (request: { functionName: string; blockNumber: bigint; args: readonly unknown[] }) => {
          blocks.push(request.blockNumber)
          if (request.functionName === 'positionOf') return { shares: 5n, queuedShares: 0n }
          if (request.functionName === 'poolOf') return { assets: 6n, shares: 10n }
          return (BigInt(request.args[1] as bigint) * 10n) / 6n
        },
      },
    } as unknown as import('./actions.ts').Ctx
    expect(await undelegationShares(ctx, account, account, 2n)).toBe(3n)
    expect(await undelegationShares(ctx, account, account, 3n)).toBe(5n)
    await expect(undelegationShares(ctx, account, account, 4n)).rejects.toThrow('owned position')
    await expect(undelegationShares(ctx, account, account, 0n)).rejects.toThrow('positive')
    expect(blocks.every((block) => block === 100n)).toBe(true)
  })
})
