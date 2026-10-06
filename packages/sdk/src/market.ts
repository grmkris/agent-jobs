/**
 * The SIDE market (`deployment.market`): the Uniswap v4 SIDE/quote pool from the liquidity seed. Explore's Buy reads
 * its price, quotes an exact-input swap and builds the transactions. Testnet swaps through `V4SwapHelper` (Monad
 * testnet has no UniversalRouter); a mainnet market is null until the launch pool and Uniswap's router are configured.
 */
import { type Address, type Hex, encodeFunctionData, erc20Abi, parseAbi } from 'viem'
import { v4SwapHelperAbi } from './abi/index.ts'
import type { TxRequest } from './board-client.ts'
import type { Ctx } from './actions.ts'
import type { Market } from './deployment.ts'

const stateViewAbi = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)'])

/** Default slippage for Buy, in basis points. */
export const DEFAULT_SLIPPAGE_BPS = 100

function direction(m: Market, tokenIn: Address): boolean {
  const t = tokenIn.toLowerCase()
  if (t !== m.side.toLowerCase() && t !== m.quote.toLowerCase()) throw new Error('The market trades SIDE and its quote token only')
  return t === m.key.currency0.toLowerCase()
}

function helperOf(m: Market): Address {
  if (m.swapper.kind !== 'helper') throw new Error('Swaps through the UniversalRouter are not available yet')
  return m.swapper.helper
}

const poolKeyArg = (m: Market) => ({ ...m.key })

/** The pool's mid price: quote tokens per whole SIDE, from slot0 (decimals of both tokens applied). */
export async function sidePrice(ctx: Ctx, m: Market, quoteDecimals: number): Promise<number> {
  const [sqrtPriceX96] = await ctx.publicClient.readContract({ address: m.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [m.poolId] })
  if (sqrtPriceX96 === 0n) return 0
  const ratio = Number(sqrtPriceX96) / 2 ** 96
  const raw1Per0 = ratio * ratio
  const sideIs0 = m.side.toLowerCase() === m.key.currency0.toLowerCase()
  const rawQuotePerSide = sideIs0 ? raw1Per0 : 1 / raw1Per0
  return rawQuotePerSide * 10 ** (18 - quoteDecimals)
}

/** What an exact-input swap of `amountIn` of `tokenIn` returns now (the swap runs in an `eth_call` and reverts). */
export async function quoteExactIn(ctx: Ctx, m: Market, tokenIn: Address, amountIn: bigint): Promise<{ amountIn: bigint; amountOut: bigint }> {
  const { result } = await ctx.publicClient.simulateContract({
    address: helperOf(m),
    abi: v4SwapHelperAbi,
    functionName: 'quoteExactIn',
    args: [poolKeyArg(m), direction(m, tokenIn), amountIn],
  })
  return { amountIn: result[0], amountOut: result[1] }
}

/** The least to accept for a quoted output at `slippageBps`. */
export const minOutFor = (amountOut: bigint, slippageBps = DEFAULT_SLIPPAGE_BPS) => (amountOut * BigInt(10_000 - slippageBps)) / 10_000n

/**
 * The transactions for an exact-input swap from `owner`: an approval of exactly `amountIn` when the allowance is
 * short, then the swap with `minOut` and `deadline`. The output goes to `owner`.
 */
export async function swapTransactions(
  ctx: Ctx,
  m: Market,
  input: { owner: Address; tokenIn: Address; amountIn: bigint; minOut: bigint; deadline: number },
): Promise<TxRequest[]> {
  const helper = helperOf(m)
  const zeroForOne = direction(m, input.tokenIn)
  const chainId = ctx.deployment.chainId
  const txs: TxRequest[] = []
  const allowance = await ctx.publicClient.readContract({ address: input.tokenIn, abi: erc20Abi, functionName: 'allowance', args: [input.owner, helper] })
  if (allowance < input.amountIn) {
    txs.push({
      description: 'Allow the swap to spend exactly this amount',
      chainId,
      to: input.tokenIn,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [helper, input.amountIn] }),
      value: '0',
      gas: '80000',
    })
  }
  txs.push({
    description: 'Swap',
    chainId,
    to: helper,
    data: encodeFunctionData({
      abi: v4SwapHelperAbi,
      functionName: 'swapExactIn',
      args: [poolKeyArg(m), zeroForOne, input.amountIn, input.minOut, input.owner, BigInt(input.deadline)],
    }) as Hex,
    value: '0',
    gas: '400000',
  })
  return txs
}
