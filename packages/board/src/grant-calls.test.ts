import { describe, expect, it } from 'vitest'
import * as sdk from '@sidequest/sdk'
import { encodeFunctionData, erc20Abi } from 'viem'
import { checkGrantCall, checkHireFunding } from './grant-calls.ts'
import { buildHireBatch, decodeGrantBatch, redeemGrantBatch } from './hire-batch.ts'

const d = sdk.deployment('monad-testnet')
const ctx = { deployment: d, stack: sdk.stack(d, 'main') }
const operator = '0x1111111111111111111111111111111111111111' as const
const agent = '0x2222222222222222222222222222222222222222' as const
const start = 1_800_000_000
const token = d.rewardTokens[0]!
const workSpec: sdk.GrantSpec = { kind: 'agent-work', delegator: agent, salt: 1n, start }
const approvalSpec: sdk.GrantSpec = { kind: 'agent-approve', delegator: agent, salt: 2n, start }
const allowanceSpec: sdk.GrantSpec = { kind: 'allowance-once', delegator: operator, agent, token, amount: 100n, salt: 3n, start }
const allowance = sdk.buildGrant(ctx, allowanceSpec)
const publish = encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'publish', args: [{
  approver: agent, arbitrator: operator, manifestHash: sdk.EMPTY_HASH, policyHash: sdk.EMPTY_HASH,
  token, reward: 100n, creatorBond: 0n, workerBond: 0n, deliveryDeadline: start + 3600, expiredAt: start + 7200,
  reviewWindow: 3600, disputeWindow: 3600, arbitrationWindow: 43200,
}] })

function entries() {
  const data = buildHireBatch({ allowance, work: sdk.buildGrant(ctx, workSpec), approval: sdk.buildGrant(ctx, approvalSpec),
    manager: d.delegation.manager, holding: ctx.stack.holding, token, agent, amount: 100n, publish })
  return decodeGrantBatch(data)
}

function checked(input = entries()) {
  return input.map((entry, index) => {
    const spec = index === 1 ? approvalSpec : workSpec
    return { spec, checked: checkGrantCall(ctx, spec, { to: entry.execution.target, data: entry.execution.callData, value: entry.execution.value.toString() }) }
  })
}

const lookup = () => ({ spec: allowanceSpec, grant: allowance })

describe('per-grant calls', () => {
  it('pins routine vault recovery to self and one-off undelegation to the approved shares', () => {
    const vault = d.sidequest!.vault
    for (const functionName of ['cancelUndelegate', 'withdraw'] as const) {
      const call = { to: vault, data: encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName, args: [agent] }) }
      expect(checkGrantCall(ctx, workSpec, call).method).toBe(functionName)
      expect(() => checkGrantCall(ctx, workSpec, { ...call, data: encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName, args: [operator] }) })).toThrow('own position')
    }
    const spec: sdk.GrantSpec = { kind: 'unstake', delegator: agent, shares: 17n, salt: 17n, start, operationId: `0x${'17'.repeat(32)}` }
    const call = { to: vault, data: encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'requestUndelegate', args: [agent, 17n] }) }
    expect(checkGrantCall(ctx, spec, call).method).toBe('requestUndelegate')
    expect(() => checkGrantCall(ctx, workSpec, call)).toThrow('outside')
    expect(() => checkGrantCall(ctx, spec, { ...call, data: encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'requestUndelegate', args: [operator, 17n] }) })).toThrow('account or shares')
    expect(() => checkGrantCall(ctx, spec, { ...call, data: encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'requestUndelegate', args: [agent, 18n] }) })).toThrow('account or shares')
  })
  it('pins approval spender and sweep recipient, and rejects unsafe methods or values', () => {
    const approve = { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ctx.stack.holding, 100n] }) }
    expect(checkGrantCall(ctx, approvalSpec, approve).method).toBe('approve')
    expect(() => checkGrantCall(ctx, approvalSpec, { ...approve, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [operator, 100n] }) })).toThrow('spender or recipient')
    expect(() => checkGrantCall(ctx, approvalSpec, { ...approve, to: d.factory })).toThrow('outside')
    expect(() => checkGrantCall(ctx, approvalSpec, { ...approve, value: '1' })).toThrow('zero value')
    expect(() => checkGrantCall(ctx, approvalSpec, { ...approve, data: `${approve.data}00` })).toThrow('canonical')
    const sweepSpec: sdk.GrantSpec = { kind: 'agent-sweep', delegator: agent, operator, salt: 4n, start }
    const transfer = sdk.advanceExecution(d.factory, operator, 100n)
    expect(checkGrantCall(ctx, sweepSpec, { to: transfer.target, data: transfer.callData }).method).toBe('transfer')
    expect(() => checkGrantCall(ctx, sweepSpec, { to: transfer.target, data: sdk.advanceExecution(d.factory, agent, 100n).callData })).toThrow('recipient')
  })

  it('accepts only a matched operator allowance, exact pull, Holding approval and publish', () => {
    expect(checkHireFunding(ctx, operator, agent, checked(), lookup)).toBe(1)
    expect(() => checkHireFunding(ctx, agent, agent, checked(), lookup)).toThrow('operator grant')
    const changed = entries()
    const wrongApproval = { ...changed[1]!, execution: { ...changed[1]!.execution,
      callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ctx.stack.holding, 101n] }) } }
    expect(() => checkHireFunding(ctx, operator, agent, checked([changed[0]!, wrongApproval, changed[2]!]), lookup)).toThrow('published reward')
    expect(() => checkHireFunding(ctx, operator, agent, checked().slice(2), lookup)).toThrow('atomic hire triple')
    expect(() => checkHireFunding(ctx, operator, agent, checked().slice(0, 1), lookup)).toThrow('work, approval and publish')
  })

  it('rejects a noncanonical manager call and a forged nested signature', () => {
    const data = redeemGrantBatch(entries())
    expect(() => decodeGrantBatch(`${data}00`)).toThrow('Noncanonical')
    const changed = entries()
    expect(() => checkHireFunding(ctx, operator, agent, checked(changed), () => ({ spec: allowanceSpec, grant: { ...allowance, signature: '0x01' } }))).toThrow('stored operator grant')
  })
})
