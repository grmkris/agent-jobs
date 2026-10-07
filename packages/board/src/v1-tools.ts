import { erc20Abi } from 'viem'
/** Unsigned v1 wallet actions. Amounts enter in token units and leave as base-unit strings. */
import * as sdk from '@sidequest/sdk'
import { type Address, encodeFunctionData, parseUnits, maxUint256 } from 'viem'
import { transaction } from './sidequest.ts'

type Fail = (code: 'invalid' | 'conflict', message: string) => Error
export function requireV1(ctx: sdk.Ctx, fail: Fail) {
  if (ctx.stack.kind !== 'sidequest-v1' || ctx.deployment.sidequest === null)
    throw fail('conflict', 'this action requires a deployed Sidequest v1 stack')
  return ctx.deployment.sidequest
}
export function positiveAmount(text: string, decimals: number, fail: Fail): bigint {
  if (typeof text !== 'string' || !/^\d+(?:\.\d+)?$/.test(text) || (text.split('.')[1]?.length ?? 0) > decimals)
    throw fail('invalid', `amount must be a positive decimal with at most ${decimals} fractional digits`)
  const amount = parseUnits(text, decimals)
  if (amount <= 0n || amount > maxUint256) throw fail('invalid', 'amount must be a positive uint256 token amount')
  return amount
}
async function approved(
  ctx: sdk.Ctx,
  wallet: Address,
  token: Address,
  spender: Address,
  amount: bigint,
  fail: Fail,
): Promise<sdk.TxRequest[]> {
  const [balance, allowance] = await Promise.all([
    sdk.balanceOf(ctx, token, wallet),
    ctx.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet, spender],
    }),
  ])
  if (balance < amount) throw fail('conflict', 'the wallet has insufficient token balance')
  return allowance >= amount
    ? []
    : [
        transaction(
          ctx,
          'Approve the exact amount',
          token,
          encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
        ),
      ]
}
export async function prepareTopUp(ctx: sdk.Ctx, wallet: Address, jobId: bigint, text: string, fail: Fail) {
  requireV1(ctx, fail)
  const [job, listing, decision, paused] = await Promise.all([
    sdk.getJob(ctx, jobId),
    sdk.getV1Listing(ctx, jobId),
    sdk.caseOf(ctx, jobId),
    ctx.publicClient.readContract({ address: ctx.deployment.core, abi: sdk.coreAbi, functionName: 'paused' }),
  ])
  if (paused || !['Funded', 'Submitted'].includes(job.statusName) || decision.outcome !== 0)
    throw fail('conflict', 'top-ups require an active, undecided job on an unpaused core')
  const decimals = await ctx.publicClient.readContract({
    address: listing.token,
    abi: erc20Abi,
    functionName: 'decimals',
  })
  const amount = positiveAmount(text, decimals, fail)
  return {
    token: listing.token,
    amount: amount.toString(),
    transactions: [
      ...(await approved(ctx, wallet, listing.token, ctx.stack.holding, amount, fail)),
      transaction(
        ctx,
        'Add to the agreed reward',
        ctx.stack.holding,
        encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'topUp', args: [jobId, amount] }),
      ),
    ],
  }
}
export async function prepareStake(ctx: sdk.Ctx, wallet: Address, text: string, fail: Fail, account: Address = wallet) {
  const h = requireV1(ctx, fail)
  const amount = positiveAmount(text, 18, fail)
  if (
    !(await ctx.publicClient.readContract({ address: h.vault, abi: sdk.stakeVaultAbi, functionName: 'bootstrapped' }))
  )
    throw fail('conflict', 'the stake vault has not opened yet')
  const shares = await ctx.publicClient.readContract({
    address: h.vault,
    abi: sdk.stakeVaultAbi,
    functionName: 'convertToShares',
    args: [account, amount],
  })
  if (shares === 0n) throw fail('conflict', 'this amount rounds to zero shares')
  return {
    account,
    delegator: wallet,
    payer: wallet,
    token: h.factory,
    amount: amount.toString(),
    shares: shares.toString(),
    transactions: [
      ...(await approved(ctx, wallet, h.factory, h.vault, amount, fail)),
      transaction(
        ctx,
        'Back the agent with wallet-owned SIDE',
        h.vault,
        encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'delegate', args: [account, amount] }),
      ),
    ],
  }
}
export async function prepareUnstake(
  ctx: sdk.Ctx,
  wallet: Address,
  text: string,
  fail: Fail,
  account: Address = wallet,
) {
  const h = requireV1(ctx, fail)
  const amount = positiveAmount(text, 18, fail)
  const shares = await sdk.undelegationShares(ctx, account, wallet, amount)
  return {
    account,
    delegator: wallet,
    token: h.factory,
    amount: amount.toString(),
    shares: shares.toString(),
    transactions: [
      transaction(
        ctx,
        'Queue your position for undelegation',
        h.vault,
        encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'requestUndelegate', args: [account, shares] }),
      ),
    ],
  }
}
export async function prepareStakeWithdrawal(ctx: sdk.Ctx, wallet: Address, fail: Fail, account: Address = wallet) {
  const h = requireV1(ctx, fail)
  const block = await ctx.publicClient.getBlock()
  const [position, backing] = await Promise.all([
    sdk.getPosition(ctx, account, wallet, { blockNumber: block.number }),
    sdk.getBacking(ctx, account, { blockNumber: block.number }),
  ])
  if (position.queuedShares === 0n || Number(block.timestamp) < position.unlockAt)
    throw fail('conflict', 'no queued position has completed its cooldown')
  if (backing.assets - position.queued < backing.reserved)
    throw fail('conflict', 'the position still backs an open bond; wait for its release')
  return {
    account,
    delegator: wallet,
    token: h.factory,
    amount: position.queued.toString(),
    shares: position.queuedShares.toString(),
    transactions: [
      transaction(
        ctx,
        'Withdraw your position to its owner wallet',
        h.vault,
        encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'withdraw', args: [account] }),
      ),
    ],
  }
}
export async function prepareCancelUnstake(ctx: sdk.Ctx, wallet: Address, fail: Fail, account: Address = wallet) {
  const h = requireV1(ctx, fail)
  const position = await sdk.getPosition(ctx, account, wallet)
  if (position.queuedShares === 0n) throw fail('conflict', 'this position has no queued exit')
  return {
    account,
    delegator: wallet,
    token: h.factory,
    amount: position.queued.toString(),
    shares: position.queuedShares.toString(),
    transactions: [
      transaction(
        ctx,
        'Cancel the queued exit and restore active backing',
        h.vault,
        encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'cancelUndelegate', args: [account] }),
      ),
    ],
  }
}
