import { describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, decodeFunctionData, erc20Abi } from 'viem'
import { backingDeposit, preparePublishFunding, readBondPolicy } from './bond-policy.ts'
import { sidequestHoldingAbi, stakeVaultAbi } from './abi/index.ts'
import { context } from './client.ts'

const owner = '0x1111111111111111111111111111111111111111' as const
const FLOOR = 10n * 10n ** 18n
function fixture(assets = 0n, liquid = FLOOR, allowance = 0n) {
  const ctx = context('monad-testnet', 'main', 'http://unit.invalid')
  let floor = FLOOR
  let admitted = true,
    denied = false
  const read = vi.spyOn(ctx.publicClient, 'readContract').mockImplementation(async (r) => {
    switch (r.functionName) {
      case 'minimumCreatorBond':
        return floor
      case 'unfilledForfeitBps':
        return 2500
      case 'CANCEL_GRACE':
        return 600
      case 'treasury':
        return ctx.deployment.sidequest!.safe
      case 'UNSTAKE_DELAY':
        return 259200
      case 'poolOf':
        return { assets, shares: assets, queuedShares: 0n, reserved: 0n }
      case 'balanceOf':
        return liquid
      case 'allowance':
        return allowance
      case 'isHolding':
        return admitted
      case 'holdingDenied':
        return denied
      default:
        throw new Error(`Unexpected ${r.functionName}`)
    }
  })
  // SAFETY: this funding fixture reads only the block timestamp.
  vi.spyOn(ctx.publicClient, 'getBlock').mockResolvedValue({ timestamp: 1000n } as never)
  const publish = {
    chainId: ctx.deployment.chainId,
    to: ctx.stack.holding,
    value: '0' as const,
    description: 'Publish',
    data: encodeFunctionData({
      abi: sidequestHoldingAbi,
      functionName: 'publish',
      args: [
        {
          approver: owner,
          arbitrator: ctx.deployment.sidequest!.safe,
          manifestHash: `0x${'11'.repeat(32)}`,
          policyHash: `0x${'22'.repeat(32)}`,
          token: ctx.deployment.rewardTokens[0]!,
          reward: 100n,
          creatorBond: FLOOR,
          workerBond: 0n,
          deliveryDeadline: 2000,
          expiredAt: 2600,
          reviewWindow: 120,
          disputeWindow: 120,
          arbitrationWindow: 300,
        },
      ],
    }),
  }
  return {
    ctx,
    publish,
    read,
    setFloor: (amount: bigint) => {
      floor = amount
    },
    setAdmission: (active: boolean, vetoed: boolean) => {
      admitted = active
      denied = vetoed
    },
  }
}

describe('live bond policy', () => {
  it('reads mutable policy afresh', async () => {
    const f = fixture()
    expect(await readBondPolicy(f.ctx)).toMatchObject({
      minimumCreatorBond: FLOOR,
      unfilledForfeitBps: 2500,
      cancelGrace: 600,
    })
    f.setFloor(FLOOR * 2n)
    expect((await readBondPolicy(f.ctx)).minimumCreatorBond).toBe(FLOOR * 2n)
  })
  it('prepares stake then reward approval then publish, without a fee transfer', async () => {
    const f = fixture()
    const plan = await preparePublishFunding(f.ctx, owner, f.publish)
    expect(plan.bondDeposit).toBe(FLOOR)
    expect(plan.sideShortfall).toBe(0n)
    expect(plan.transactions.map((tx) => tx.to)).toEqual([
      f.ctx.deployment.factory,
      f.ctx.deployment.sidequest!.vault,
      f.ctx.deployment.rewardTokens[0],
      f.ctx.stack.holding,
    ])
    expect(decodeFunctionData({ abi: stakeVaultAbi, data: plan.transactions[1]!.data }).functionName).toBe('delegate')
    expect(decodeFunctionData({ abi: erc20Abi, data: plan.transactions[2]!.data }).args).toEqual([
      f.ctx.stack.holding,
      100n,
    ])
  })
  it('clears a nonzero insufficient reward allowance before increasing it', async () => {
    const f = fixture(FLOOR, FLOOR, 50n)
    const plan = await preparePublishFunding(f.ctx, owner, f.publish)
    const approvals = plan.transactions.slice(0, -1).map((tx) => decodeFunctionData({ abi: erc20Abi, data: tx.data }))
    expect(approvals.map((call) => call.args)).toEqual([
      [f.ctx.stack.holding, 0n],
      [f.ctx.stack.holding, 100n],
    ])
    expect(plan.transactions.at(-1)).toEqual(f.publish)
  })
  it('skips stake for sufficient backing and reports a liquid shortfall', async () => {
    const f = fixture(FLOOR)
    expect((await preparePublishFunding(f.ctx, owner, f.publish)).transactions).toHaveLength(2)
    const poor = fixture(0n, 1n)
    expect((await preparePublishFunding(poor.ctx, owner, poor.publish)).sideShortfall).toBe(FLOOR - 1n)
  })
  it('rejects a frozen offer below the new floor', async () => {
    const f = fixture()
    f.setFloor(FLOOR * 2n)
    await expect(preparePublishFunding(f.ctx, owner, f.publish)).rejects.toThrow('at least 20 SIDE')
  })
  it('includes a SIDE reward in liquid funding requirements', async () => {
    const f = fixture()
    const decoded = decodeFunctionData({ abi: sidequestHoldingAbi, data: f.publish.data })
    if (decoded.functionName !== 'publish') throw new Error('Expected publish fixture')
    const p = decoded.args[0]
    const publish = {
      ...f.publish,
      data: encodeFunctionData({
        abi: sidequestHoldingAbi,
        functionName: 'publish',
        args: [{ ...p, token: f.ctx.deployment.factory }],
      }),
    }
    expect((await preparePublishFunding(f.ctx, owner, publish)).sideShortfall).toBe(100n)
  })
  it('accounts for queued backing and existing reservations', () => {
    expect(backingDeposit({ assets: 100n, shares: 100n, queuedShares: 50n, reserved: 60n }, 10n)).toBe(20n)
    expect(backingDeposit({ assets: 100n, shares: 100n, queuedShares: 50n, reserved: 0n }, 10n)).toBe(0n)
  })
  it('rejects invalid pools instead of preparing money movement', () => {
    expect(() => backingDeposit({ assets: 100n, shares: 100n, queuedShares: 101n, reserved: 0n }, 10n)).toThrow(
      'Invalid backing',
    )
  })

  it('refuses funding when the Holding is revoked or the wallet has denied it', async () => {
    const f = fixture()
    f.setAdmission(false, false)
    await expect(preparePublishFunding(f.ctx, owner, f.publish)).rejects.toThrow('not admitted')
    f.setAdmission(true, true)
    await expect(preparePublishFunding(f.ctx, owner, f.publish)).rejects.toThrow('Re-allow')
    expect(f.read.mock.calls.some(([r]) => r.functionName === 'poolOf' || r.functionName === 'allowance')).toBe(false)
  })
})
