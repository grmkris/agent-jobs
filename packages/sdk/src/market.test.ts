import { describe, expect, it } from 'vitest'
import {
  decodeAbiParameters,
  decodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbiParameters,
  type Address,
  type Hex,
} from 'viem'
import type { Ctx } from './actions.ts'
import { deployment } from './deployment.ts'
import { minOutFor, permit2Abi, sidePrice, swapTransactions, universalRouterAbi } from './market.ts'

const owner = '0x00000000000000000000000000000000000000aa' as Address
const d = deployment('monad-testnet')
const m = d.market!

function ctx(reads: { tokenAllowance?: bigint; permit?: [bigint, number]; sqrtPriceX96?: bigint }): Ctx {
  return {
    deployment: d,
    publicClient: {
      readContract: async ({ functionName, address }: { functionName: string; address: Address }) =>
        functionName === 'allowance' && address === m.permit2
          ? [reads.permit?.[0] ?? 0n, reads.permit?.[1] ?? 0, 0]
          : functionName === 'allowance'
            ? (reads.tokenAllowance ?? 0n)
            : [reads.sqrtPriceX96 ?? 0n, 0, 0, 3000],
    },
  } as unknown as Ctx
}

function decodeSwap(data: Hex) {
  const { args } = decodeFunctionData({ abi: universalRouterAbi, data })
  const [commands, inputs, deadline] = args
  const [actions, params] = decodeAbiParameters(parseAbiParameters('bytes, bytes[]'), inputs[0]!)
  const [single] = decodeAbiParameters(
    parseAbiParameters(
      '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)',
    ),
    params[0]!,
  )
  const settle = decodeAbiParameters(parseAbiParameters('address, uint256'), params[1]!)
  const take = decodeAbiParameters(parseAbiParameters('address, uint256'), params[2]!)
  return { commands, deadline, actions, single, settle, take, count: inputs.length }
}

describe('the SIDE market', () => {
  it("is the seeded testnet SIDE/mUSD pool, traded through Uniswap's router and quoter", () => {
    expect(m.side).toBe(d.factory)
    expect(m.quote).toBe(d.rewardTokens[0])
    expect(m.key).toMatchObject({ fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' })
    expect(m.key.currency0.toLowerCase() < m.key.currency1.toLowerCase()).toBe(true)
    expect(m.poolId).toBe('0xac80f2a6407197a621073182fa2c4b60d754c05513ee424b59b6905b9a66e8af')
    expect(m.universalRouter).toBe('0x1b7bFCd2870329B987191910D85c22C7287f3c22')
    expect(m.quoter).toBe('0x869834d127b230283fe63E0d0A9bEB67216a94C7')
    expect(m.minHopPrice).toBe(true)
  })

  it('approves Permit2 and the router for exactly the input, then swaps exact-in with minOut and deadline', async () => {
    const txs = await swapTransactions(ctx({}), m, {
      owner,
      tokenIn: m.quote,
      amountIn: 10_000_000n,
      minOut: 97_000n * 10n ** 18n,
      deadline: 2_000_000_000,
    })
    expect(txs.map((t) => t.to)).toEqual([m.quote, m.permit2, m.universalRouter])
    expect(decodeFunctionData({ abi: erc20Abi, data: txs[0]!.data }).args).toEqual([m.permit2, 10_000_000n])
    const permit = decodeFunctionData({ abi: permit2Abi, data: txs[1]!.data })
    expect(permit.args.slice(0, 3)).toEqual([m.quote, m.universalRouter, 10_000_000n])
    const s = decodeSwap(txs[2]!.data)
    expect([s.commands, s.count, s.actions, s.deadline]).toEqual(['0x10', 1, '0x060c0f', 2_000_000_000n])
    // mUSD sorts first on testnet, so buying SIDE with it is zero-for-one; no per-hop floor, minOut binds.
    expect(s.single).toMatchObject({
      zeroForOne: true,
      amountIn: 10_000_000n,
      amountOutMinimum: 97_000n * 10n ** 18n,
      minHopPriceX36: 0n,
      hookData: '0x',
    })
    expect(s.settle).toEqual([getAddress(m.quote), 10_000_000n])
    expect(s.take).toEqual([getAddress(m.side), 97_000n * 10n ** 18n])
  })

  it('skips approvals that already cover the swap, and selling SIDE is one-for-zero', async () => {
    const covered = await swapTransactions(
      ctx({ tokenAllowance: 10n ** 30n, permit: [10n ** 30n, 2_100_000_000] }),
      m,
      { owner, tokenIn: m.side, amountIn: 5n * 10n ** 18n, minOut: 1n, deadline: 2_000_000_000 },
    )
    expect(covered.map((t) => t.description)).toEqual(['Swap'])
    expect(decodeSwap(covered[0]!.data).single.zeroForOne).toBe(false)
    const expired = await swapTransactions(ctx({ tokenAllowance: 10n ** 30n, permit: [10n ** 30n, 1] }), m, {
      owner,
      tokenIn: m.side,
      amountIn: 1n,
      minOut: 1n,
      deadline: 2_000_000_000,
    })
    expect(expired.map((t) => t.to)).toEqual([m.permit2, m.universalRouter])
  })

  it('encodes the original ExactInputSingleParams for a router without the per-hop floor (Monad mainnet)', async () => {
    const original = { ...m, minHopPrice: false }
    const [swap] = await swapTransactions(
      ctx({ tokenAllowance: 10n ** 30n, permit: [10n ** 30n, 2_100_000_000] }),
      original,
      { owner, tokenIn: m.quote, amountIn: 2_000_000n, minOut: 7n, deadline: 2_000_000_000 },
    )
    const { args } = decodeFunctionData({ abi: universalRouterAbi, data: swap!.data })
    const [, params] = decodeAbiParameters(parseAbiParameters('bytes, bytes[]'), args[1][0]!)
    const [single] = decodeAbiParameters(
      parseAbiParameters(
        '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)',
      ),
      params[0]!,
    )
    expect(single).toMatchObject({ zeroForOne: true, amountIn: 2_000_000n, amountOutMinimum: 7n, hookData: '0x' })
    // Five fields: key (5 words), zeroForOne, amountIn, amountOutMinimum, hookData offset; then the empty hookData.
    expect((params[0]!.length - 2) / 64).toBe(1 + 5 + 3 + 1 + 1)
  })

  it('refuses a token the pool does not trade, applies slippage, and reads the mid price', async () => {
    await expect(
      swapTransactions(ctx({}), m, { owner, tokenIn: owner, amountIn: 1n, minOut: 0n, deadline: 1 }),
    ).rejects.toThrow('SIDE and its quote token only')
    expect(minOutFor(10_000n)).toBe(9_900n)
    expect(minOutFor(10_000n, 50)).toBe(9_950n)
    // The seeded price: 10M SIDE for 1,000 mUSD.
    expect(await sidePrice(ctx({ sqrtPriceX96: 7922816251426433759354395033600000000n }), m, 6)).toBeCloseTo(0.0001, 10)
    expect(await sidePrice(ctx({}), m, 6)).toBe(0)
  })
})
