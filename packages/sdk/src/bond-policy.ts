/** Live creator-bond policy and the stake needed before a publish. */
import { type Address, decodeFunctionData, encodeFunctionData, erc20Abi, formatEther } from 'viem'
import type { Ctx } from './actions.ts'
import type { TxRequest } from './board-client.ts'
import { sidequestHoldingAbi, stakeVaultAbi, feeScheduleAbi } from './abi/index.ts'
import { requireBondHorizon } from './clocks.ts'

export interface BondPolicy {
  minimumCreatorBond: bigint
  unfilledForfeitBps: number
  cancelGrace: number
  treasury: Address
}

/** Read the vault admission switches before preparing a user-funded backing deposit. */
export async function requireFundingAdmission(ctx: Ctx, owner: Address): Promise<void> {
  const protocol = ctx.deployment.sidequest
  if (protocol === null) throw new Error('Creator-bond funding requires Sidequest')
  const [admitted, denied] = await Promise.all([
    ctx.publicClient.readContract({
      address: protocol.vault,
      abi: stakeVaultAbi,
      functionName: 'isHolding',
      args: [ctx.stack.holding],
    }),
    ctx.publicClient.readContract({
      address: protocol.vault,
      abi: stakeVaultAbi,
      functionName: 'holdingDenied',
      args: [owner, ctx.stack.holding],
    }),
  ])
  if (!admitted) throw new Error('This Holding is not admitted by the stake vault. Publishing is unavailable.')
  if (denied) throw new Error('Your wallet has denied this Holding. Re-allow it in stake management before funding.')
}

export async function readBondPolicy(ctx: Ctx): Promise<BondPolicy> {
  const protocol = ctx.deployment.sidequest
  if (protocol === null) throw new Error('Creator-bond policy requires Sidequest')
  const [minimumCreatorBond, unfilledForfeitBps, cancelGrace, treasury] = await Promise.all([
    ctx.publicClient.readContract({
      address: ctx.stack.holding,
      abi: sidequestHoldingAbi,
      functionName: 'minimumCreatorBond',
    }),
    ctx.publicClient.readContract({
      address: ctx.stack.holding,
      abi: sidequestHoldingAbi,
      functionName: 'unfilledForfeitBps',
    }),
    ctx.publicClient.readContract({
      address: ctx.stack.holding,
      abi: sidequestHoldingAbi,
      functionName: 'CANCEL_GRACE',
    }),
    ctx.publicClient.readContract({ address: protocol.feeSchedule, abi: feeScheduleAbi, functionName: 'treasury' }),
  ])
  if (minimumCreatorBond === 0n || unfilledForfeitBps > 5000 || cancelGrace <= 0)
    throw new Error('Invalid deployed creator-bond policy')
  if (
    treasury.toLowerCase() === '0x0000000000000000000000000000000000000000' ||
    treasury.toLowerCase() === ctx.stack.holding.toLowerCase()
  )
    throw new Error('Invalid bond treasury')
  return {
    minimumCreatorBond,
    unfilledForfeitBps: unfilledForfeitBps,
    cancelGrace: cancelGrace,
    treasury,
  }
}

export function requireCreatorBond(policy: BondPolicy, amount: bigint): void {
  if (amount < policy.minimumCreatorBond)
    throw new Error(`Creator bond must be at least ${formatEther(policy.minimumCreatorBond)} SIDE`)
}

const max = (a: bigint, b: bigint) => (a > b ? a : b)

export function backingDeposit(
  pool: { assets: bigint; shares: bigint; queuedShares: bigint; reserved: bigint },
  bond: bigint,
): bigint {
  const activeAfter = (deposit: bigint) => {
    const minted = pool.assets === 0n || pool.shares === 0n ? deposit : (deposit * pool.shares) / pool.assets
    const shares = pool.shares + minted
    return shares === 0n ? 0n : ((pool.assets + deposit) * (shares - pool.queuedShares)) / shares
  }
  if (
    bond < 0n ||
    pool.assets < 0n ||
    pool.shares < 0n ||
    pool.queuedShares < 0n ||
    pool.queuedShares > pool.shares ||
    pool.reserved > pool.assets
  )
    throw new Error('Invalid backing pool')
  const capacity = (1n << 128n) - 1n - pool.assets
  if (activeAfter(0n) >= pool.reserved + bond) return 0n
  if (activeAfter(capacity) < pool.reserved + bond) throw new Error('Backing deposit exceeds vault capacity')
  let lo = 0n,
    hi = capacity
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n
    if (activeAfter(mid) >= pool.reserved + bond) hi = mid
    else lo = mid
  }
  const deposit = max(hi, pool.shares === 0n ? 1n : (pool.assets + pool.shares - 1n) / pool.shares)
  const minted = pool.assets === 0n || pool.shares === 0n ? deposit : (deposit * pool.shares) / pool.assets
  if (deposit > capacity || pool.shares + minted > (1n << 192n) - 1n)
    throw new Error('Backing deposit exceeds vault capacity')
  return deposit
}

export interface PublishFundingPlan {
  policy: BondPolicy
  bondDeposit: bigint
  sideShortfall: bigint
  transactions: TxRequest[]
}

/** Prepare the SIDE backing and reward approval before publishing. */
export async function preparePublishFunding(ctx: Ctx, owner: Address, publish: TxRequest): Promise<PublishFundingPlan> {
  if (publish.chainId !== ctx.deployment.chainId || publish.value !== '0')
    throw new Error('Publish must use this chain and zero native value')
  if (publish.to.toLowerCase() !== ctx.stack.holding.toLowerCase()) throw new Error('Publish names another Holding')
  const decoded = decodeFunctionData({ abi: sidequestHoldingAbi, data: publish.data })
  if (decoded.functionName !== 'publish') throw new Error('Expected publish')
  const p = decoded.args[0]
  if (p.reward === 0n) throw new Error('A published reward must be positive')
  if (p.deliveryDeadline <= Number((await ctx.publicClient.getBlock()).timestamp))
    throw new Error('The delivery deadline passed. Prepare a new offer.')
  const policy = await readBondPolicy(ctx)
  requireCreatorBond(policy, p.creatorBond)
  await requireFundingAdmission(ctx, owner)
  await requireBondHorizon(ctx, p.expiredAt, p.creatorBond, p.workerBond)
  const protocol = ctx.deployment.sidequest
  if (protocol === null) throw new Error('No vault configured')
  const [pool, liquid] = await Promise.all([
    ctx.publicClient.readContract({
      address: protocol.vault,
      abi: stakeVaultAbi,
      functionName: 'poolOf',
      args: [owner],
    }),
    ctx.publicClient.readContract({
      address: protocol.factory,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    }),
  ])
  const bondDeposit = backingDeposit(pool, p.creatorBond)
  const sideReward = p.token.toLowerCase() === protocol.factory.toLowerCase() ? p.reward : 0n
  const sideShortfall = max(0n, bondDeposit + sideReward - liquid)
  const transactions: TxRequest[] = []
  const approve = (token: Address, spender: Address, amount: bigint, description: string): TxRequest => ({
    chainId: ctx.deployment.chainId,
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
    value: '0',
    gas: '80000',
    description,
  })
  if (bondDeposit > 0n) {
    transactions.push(approve(protocol.factory, protocol.vault, bondDeposit, 'Approve the SIDE backing deposit'))
    transactions.push({
      chainId: ctx.deployment.chainId,
      to: protocol.vault,
      data: encodeFunctionData({ abi: stakeVaultAbi, functionName: 'delegate', args: [owner, bondDeposit] }),
      value: '0',
      gas: '400000',
      description: 'Add SIDE backing owned by your wallet',
    })
  }
  const allowance = await ctx.publicClient.readContract({
    address: p.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, ctx.stack.holding],
  })
  if (allowance < p.reward) {
    if (allowance > 0n) transactions.push(approve(p.token, ctx.stack.holding, 0n, 'Clear the previous reward approval'))
    transactions.push(approve(p.token, ctx.stack.holding, p.reward, 'Approve the exact reward'))
  }
  transactions.push(publish)
  return { policy, bondDeposit, sideShortfall, transactions }
}
