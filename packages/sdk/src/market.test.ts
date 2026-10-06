import { describe, expect, it } from 'vitest'
import { decodeFunctionData, erc20Abi, getAddress, type Address } from 'viem'
import { v4SwapHelperAbi } from './abi/index.ts'
import type { Ctx } from './actions.ts'
import { deployment } from './deployment.ts'
import { minOutFor, sidePrice, swapTransactions } from './market.ts'

const owner = '0x00000000000000000000000000000000000000aa' as Address
const d = deployment('monad-testnet')
const m = d.market!

function ctx(reads: { allowance?: bigint; sqrtPriceX96?: bigint }): Ctx {
  return {
    deployment: d,
    publicClient: {
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === 'allowance' ? (reads.allowance ?? 0n) : [reads.sqrtPriceX96 ?? 0n, 0, 0, 3000],
    },
  } as unknown as Ctx
}

describe('the SIDE market', () => {
  it('is the seeded testnet SIDE/mUSD pool, swapped through the helper', () => {
    expect(m.side).toBe(d.factory)
    expect(m.quote).toBe(d.rewardTokens[0])
    expect(m.key).toMatchObject({ fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' })
    expect(m.key.currency0.toLowerCase() < m.key.currency1.toLowerCase()).toBe(true)
    expect(m.poolId).toBe('0xac80f2a6407197a621073182fa2c4b60d754c05513ee424b59b6905b9a66e8af')
    expect(m.swapper.kind).toBe('helper')
  })

  it('approves exactly the input when the allowance is short, then swaps with minOut and deadline to the owner', async () => {
    const txs = await swapTransactions(ctx({}), m, { owner, tokenIn: m.quote, amountIn: 10_000_000n, minOut: 97_000n * 10n ** 18n, deadline: 2_000_000_000 })
    expect(txs.map(t => t.description)).toEqual(['Allow the swap to spend exactly this amount', 'Swap'])
    const approve = decodeFunctionData({ abi: erc20Abi, data: txs[0]!.data })
    expect(approve.args).toEqual([m.swapper.kind === 'helper' ? m.swapper.helper : '', 10_000_000n])
    const swap = decodeFunctionData({ abi: v4SwapHelperAbi, data: txs[1]!.data })
    expect(swap.functionName).toBe('swapExactIn')
    // mUSD sorts first on testnet, so buying SIDE with it is zero-for-one.
    expect(swap.args.slice(1)).toEqual([true, 10_000_000n, 97_000n * 10n ** 18n, getAddress(owner), 2_000_000_000n])
    const covered = await swapTransactions(ctx({ allowance: 10_000_000n }), m, { owner, tokenIn: m.side, amountIn: 1n, minOut: 0n, deadline: 1 })
    expect(covered.map(t => t.description)).toEqual(['Swap'])
    expect(decodeFunctionData({ abi: v4SwapHelperAbi, data: covered[0]!.data }).args[1]).toBe(false)
  })

  it('refuses a token the pool does not trade, applies slippage, and reads the mid price', async () => {
    await expect(swapTransactions(ctx({}), m, { owner, tokenIn: owner, amountIn: 1n, minOut: 0n, deadline: 1 })).rejects.toThrow('SIDE and its quote token only')
    expect(minOutFor(10_000n)).toBe(9_900n)
    expect(minOutFor(10_000n, 50)).toBe(9_950n)
    // The seeded price: 10M SIDE for 1,000 mUSD.
    expect(await sidePrice(ctx({ sqrtPriceX96: 7922816251426433759354395033600000000n }), m, 6)).toBeCloseTo(0.0001, 10)
    expect(await sidePrice(ctx({}), m, 6)).toBe(0)
  })
})
