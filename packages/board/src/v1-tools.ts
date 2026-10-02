/** Unsigned v1 wallet actions. Amounts enter in token units and leave as base-unit strings. */
import * as sdk from '@agent-jobs/sdk'
import { type Address, encodeFunctionData, parseUnits, maxUint256 } from 'viem'
import { transaction } from './hireling.ts'

type Fail = (code: 'invalid' | 'conflict', message: string) => Error
export function requireV1(ctx: sdk.Ctx, fail: Fail) {
  if (ctx.stack.kind !== 'hireling-v1' || ctx.deployment.hireling === null) throw fail('conflict', 'this action requires a deployed Hireling v1 stack')
  return ctx.deployment.hireling
}
export function positiveAmount(text: string, decimals: number, fail: Fail): bigint {
  if (typeof text !== 'string' || !/^\d+(?:\.\d+)?$/.test(text) || (text.split('.')[1]?.length ?? 0) > decimals) throw fail('invalid', `amount must be a positive decimal with at most ${decimals} fractional digits`)
  const amount = parseUnits(text, decimals)
  if (amount <= 0n || amount > maxUint256) throw fail('invalid', 'amount must be a positive uint256 token amount')
  return amount
}
async function approved(ctx: sdk.Ctx, wallet: Address, token: Address, spender: Address, amount: bigint, fail: Fail): Promise<sdk.TxRequest[]> {
  const [balance, allowance] = await Promise.all([
    sdk.balanceOf(ctx, token, wallet),
    ctx.publicClient.readContract({ address: token, abi: sdk.factoryTokenAbi, functionName: 'allowance', args: [wallet, spender] }),
  ])
  if (balance < amount) throw fail('conflict', 'the wallet has insufficient token balance')
  return allowance >= amount ? [] : [transaction(ctx, 'Approve the exact amount', token, encodeFunctionData({ abi: sdk.factoryTokenAbi, functionName: 'approve', args: [spender, amount] }))]
}
export async function prepareTopUp(ctx: sdk.Ctx, wallet: Address, jobId: bigint, text: string, fail: Fail) {
  requireV1(ctx, fail)
  const [job, listing, decision, paused] = await Promise.all([sdk.getJob(ctx, jobId), sdk.getV1Listing(ctx, jobId), sdk.caseOf(ctx, jobId), ctx.publicClient.readContract({ address: ctx.deployment.core, abi: sdk.coreAbi, functionName: 'paused' })])
  if (paused || !['Funded', 'Submitted'].includes(job.statusName) || decision.outcome !== 0) throw fail('conflict', 'top-ups require an active, undecided job on an unpaused core')
  const decimals = await ctx.publicClient.readContract({ address: listing.token, abi: sdk.factoryTokenAbi, functionName: 'decimals' })
  const amount = positiveAmount(text, decimals, fail)
  return { token: listing.token, amount: amount.toString(), transactions: [
    ...await approved(ctx, wallet, listing.token, ctx.stack.holding, amount, fail),
    transaction(ctx, 'Add to the agreed reward', ctx.stack.holding, encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'topUp', args: [jobId, amount] })),
  ] }
}
export async function prepareStake(ctx: sdk.Ctx, wallet: Address, text: string, fail: Fail) {
  const h = requireV1(ctx, fail), amount = positiveAmount(text, 18, fail)
  if (!await ctx.publicClient.readContract({ address: h.vault, abi: sdk.stakeVaultAbi, functionName: 'bootstrapped' })) throw fail('conflict', 'the stake vault has not opened yet')
  return { token: h.factory, amount: amount.toString(), transactions: [
    ...await approved(ctx, wallet, h.factory, h.vault, amount, fail),
    transaction(ctx, 'Stake FACTORY for fees and bonds', h.vault, encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'stake', args: [amount] })),
  ] }
}
export async function prepareUnstake(ctx: sdk.Ctx, wallet: Address, text: string, fail: Fail) {
  const h = requireV1(ctx, fail), amount = positiveAmount(text, 18, fail)
  const state = await sdk.getStake(ctx, wallet)
  if (amount > state.available) throw fail('conflict', 'reserved stake cannot be unstaked; amount exceeds available stake')
  return { token: h.factory, amount: amount.toString(), transactions: [transaction(ctx, 'Start the unstaking cooldown', h.vault, encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'requestUnstake', args: [amount] }))] }
}
export async function prepareStakeWithdrawal(ctx: sdk.Ctx, wallet: Address, fail: Fail) {
  const h = requireV1(ctx, fail)
  const [state, block] = await Promise.all([sdk.getStake(ctx, wallet), ctx.publicClient.getBlock()])
  if (state.unstaking === 0n || Number(block.timestamp) < state.unlockAt) throw fail('conflict', 'no unstaked FACTORY has completed its cooldown')
  return { token: h.factory, amount: state.unstaking.toString(), transactions: [transaction(ctx, 'Withdraw unstaked FACTORY to your wallet', h.vault, encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'withdraw' }))] }
}
