/** Actual ordered redemptions against deployed MetaMask contracts and real Hireling bytecode on a local Monad fork. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as sdk from '@agent-jobs/sdk'
import { type Hex, encodeFunctionData, erc20Abi, keccak256, stringToHex } from 'viem'
import { forkEnabled, forkSetupTimeout, startHirelingFork } from '../../sdk/test/hireling-fixture.ts'
import { buildHireBatch, decodeGrantBatch } from './hire-batch.ts'
import { checkGrantCall, checkHireFunding } from './grant-calls.ts'

describe.skipIf(!forkEnabled)('atomic S1 hire against real delegation enforcers', () => {
  let fixture: Awaited<ReturnType<typeof startHirelingFork>>
  let ctx: sdk.Ctx
  let start: number
  let allowance: sdk.Delegation
  let work: sdk.Delegation
  let approval: sdk.Delegation
  let allowanceSpec: sdk.GrantSpec
  let workSpec: sdk.GrantSpec
  let approvalSpec: sdk.GrantSpec
  const token = sdk.deployment('monad-testnet').rewardTokens[0]!
  const amount = 10_000_000n
  const balance = (wallet: sdk.Wallet) => ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.account.address] })

  async function signed(wallet: sdk.Wallet, spec: sdk.GrantSpec): Promise<sdk.Delegation> {
    const grant = sdk.buildGrant(ctx, spec)
    return { ...grant, signature: await sdk.signTypedDataJson(wallet, sdk.delegationTypedData(ctx.deployment, grant)) }
  }

  function publish(index: number, invalid = false): Hex {
    return encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'publish', args: [{
      approver: fixture.worker.account.address, arbitrator: fixture.arbitrator.account.address,
      manifestHash: keccak256(stringToHex(`manifest-${index}`)), policyHash: keccak256(stringToHex(`policy-${index}`)),
      token, reward: amount, creatorBond: 0n, workerBond: 0n,
      deliveryDeadline: invalid ? start - 1 : start + 32 * 86400, expiredAt: start + 40 * 86400,
      reviewWindow: 3600, disputeWindow: 3600, arbitrationWindow: 43200,
    }] })
  }

  function batch(index: number, invalid = false): Hex {
    return buildHireBatch({ allowance, work, approval, manager: ctx.deployment.delegation.manager, holding: ctx.stack.holding,
      token, agent: fixture.contributor.account.address, amount, publish: publish(index, invalid) })
  }

  async function send(data: Hex) {
    const hash = await fixture.admin.sendTransaction({ to: ctx.deployment.delegation.manager, data, gas: 5_000_000n })
    return ctx.publicClient.waitForTransactionReceipt({ hash })
  }

  beforeAll(async () => {
    fixture = await startHirelingFork()
    ctx = { ...fixture.ctx, deployment: { ...fixture.ctx.deployment, relay: fixture.admin.account.address } }
    for (const wallet of [fixture.creator, fixture.contributor]) {
      const authorization = await wallet.signAuthorization({ contractAddress: ctx.deployment.delegation.delegator, executor: fixture.admin.account.address })
      const hash = await fixture.admin.sendTransaction({ to: wallet.account.address, data: '0x', authorizationList: [authorization] })
      expect((await ctx.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success')
    }
    await fixture.send(token, [...erc20Abi, { type: 'function', name: 'mint', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }], 'mint', [fixture.creator.account.address, 100_000_000n])
    start = Number((await ctx.publicClient.getBlock()).timestamp)
    allowanceSpec = { kind: 'allowance', delegator: fixture.creator.account.address, agent: fixture.contributor.account.address, token, amount: 25_000_000n, salt: 1n, start }
    workSpec = { kind: 'agent-work', delegator: fixture.contributor.account.address, salt: 2n, start }
    approvalSpec = { kind: 'agent-approve', delegator: fixture.contributor.account.address, salt: 3n, start }
    allowance = await signed(fixture.creator, allowanceSpec)
    work = await signed(fixture.contributor, workSpec)
    approval = await signed(fixture.contributor, approvalSpec)
  }, forkSetupTimeout())
  afterAll(() => fixture?.close())

  it('publishes with zero agent funds and matches every transfer and approval to the exact reward', async () => {
    const data = batch(1)
    const entries = decodeGrantBatch(data)
    const checked = entries.map((entry, index) => ({ spec: index === 1 ? approvalSpec : workSpec,
      checked: checkGrantCall(ctx, index === 1 ? approvalSpec : workSpec, { to: entry.execution.target, data: entry.execution.callData }) }))
    expect(checkHireFunding(ctx, fixture.creator.account.address, fixture.contributor.account.address, checked, () => ({ spec: allowanceSpec, grant: allowance }))).toBe(1)
    const before = await balance(fixture.creator)
    expect((await send(data)).status).toBe('success')
    expect(await balance(fixture.creator)).toBe(before - amount)
    expect(await balance(fixture.contributor)).toBe(0n)
    expect(await ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [fixture.contributor.account.address, ctx.stack.holding] })).toBe(0n)
    expect(await sdk.callsMade(ctx, sdk.delegationHash(work))).toBe(2n)
    expect(await sdk.callsMade(ctx, sdk.delegationHash(approval))).toBe(1n)
  }, 120_000)

  it('rolls back the transfer, approval and all grant counters when publish fails', async () => {
    const before = await balance(fixture.creator)
    const workBefore = await sdk.callsMade(ctx, sdk.delegationHash(work))
    const approvalBefore = await sdk.callsMade(ctx, sdk.delegationHash(approval))
    expect((await send(batch(2, true))).status).toBe('reverted')
    expect(await balance(fixture.creator)).toBe(before)
    expect(await balance(fixture.contributor)).toBe(0n)
    expect(await sdk.callsMade(ctx, sdk.delegationHash(work))).toBe(workBefore)
    expect(await sdk.callsMade(ctx, sdk.delegationHash(approval))).toBe(approvalBefore)
    expect(await ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [fixture.contributor.account.address, ctx.stack.holding] })).toBe(0n)
  }, 120_000)

  it('enforces the cap and permits the next fixed period only with fresh gas grants', async () => {
    expect((await send(batch(3))).status).toBe('success')
    const before = await balance(fixture.creator)
    expect((await send(batch(4))).status).toBe('reverted')
    expect(await balance(fixture.creator)).toBe(before)
    await fixture.rpc('evm_setNextBlockTimestamp', [start + sdk.ALLOWANCE_PERIOD])
    await fixture.rpc('evm_mine')
    const nextStart = Number((await ctx.publicClient.getBlock()).timestamp)
    work = await signed(fixture.contributor, { ...workSpec, salt: 4n, start: nextStart })
    approval = await signed(fixture.contributor, { ...approvalSpec, salt: 5n, start: nextStart })
    expect((await send(batch(5))).status).toBe('success')
    expect(await balance(fixture.creator)).toBe(before - amount)
  }, 120_000)

  it('uses an exact one-off allowance once and refuses a disabled grant', async () => {
    const nextStart = Number((await ctx.publicClient.getBlock()).timestamp)
    allowance = await signed(fixture.creator, { kind: 'allowance-once', delegator: fixture.creator.account.address,
      agent: fixture.contributor.account.address, token, amount, salt: 6n, start: nextStart })
    expect((await send(batch(6))).status).toBe('success')
    expect((await send(batch(7))).status).toBe('reverted')
    const hash = await fixture.contributor.sendTransaction({ to: ctx.deployment.delegation.manager, data: sdk.disableCalldata(work) })
    expect((await ctx.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success')
    expect(await sdk.isDisabled(ctx, sdk.delegationHash(work))).toBe(true)
    expect((await send(batch(8))).status).toBe('reverted')
  }, 120_000)
})
