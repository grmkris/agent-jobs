/** Permissions on demand at the sponsor boundary: only the stored operator → agent delegation, alone, inside its terms. */
import * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex, encodeAbiParameters, encodeFunctionData, erc20Abi } from 'viem'
import { describe, expect, it } from 'vitest'
import { checkGrantCall, checkHireFunding } from './grant-calls.ts'
import { grantSpecJson, parseGrantSpec } from './grants.ts'
import { buildHireBatch, decodeGrantBatch } from './hire-batch.ts'

const d = sdk.deployment('monad-testnet')
const ctx = { deployment: d, stack: sdk.stack(d, 'main') }
const operator = '0x1111111111111111111111111111111111111111' as const
const agent = '0x2222222222222222222222222222222222222222' as const
const recipient = '0x3333333333333333333333333333333333333333' as const
const start = 1_800_000_000
const token = d.rewardTokens[0]!
const workSpec: sdk.GrantSpec = { kind: 'agent-work', delegator: agent, salt: 1n, start }
const periodic: sdk.GrantSpec = { kind: 'permission', delegator: operator, agent, salt: 9n, start, expiry: start + 86_400,
  terms: { type: 'erc20-token-periodic', token, periodAmount: 10n, periodDuration: 86_400, recipient } }
const exactData = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, 4n] })
const exact: sdk.GrantSpec = { kind: 'permission', delegator: operator, agent, salt: 10n, start, expiry: start + 3600,
  terms: { type: 'hireling:contract-call', target: token, value: 0n, callData: exactData } }
const signature = `0x${'ab'.repeat(65)}` as Hex
const signed = (spec: sdk.GrantSpec) => ({ ...sdk.buildGrant(ctx, spec), signature })
const transfer = (to: Address, value: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, value] })

/** The agent's own work grant sends one manager redemption of the permission. */
function redemption(grant: sdk.Delegation, execution: sdk.Execution) {
  const call = { to: d.delegation.manager, data: sdk.redeemCalldata(grant, execution) }
  return [{ spec: workSpec, checked: checkGrantCall(ctx, workSpec, call) }]
}
const stored = (spec: sdk.GrantSpec) => () => ({ spec, grant: signed(spec) })

describe('permission redemption', () => {
  it('accepts a periodic transfer and the exact call, each as the only call', () => {
    expect(checkHireFunding(ctx, operator, agent, redemption(signed(periodic), { target: token, value: 0n, callData: transfer(recipient, 10n) }), stored(periodic))).toBe(0)
    expect(checkHireFunding(ctx, operator, agent, redemption(signed(exact), { target: token, value: 0n, callData: exactData }), stored(exact))).toBe(0)
  })

  it.each([
    ['another operator', /stored operator grant/, () => checkHireFunding(ctx, recipient, agent, redemption(signed(periodic), { target: token, value: 0n, callData: transfer(recipient, 1n) }), stored(periodic))],
    ['another agent', /stored operator grant/, () => checkHireFunding(ctx, operator, recipient, redemption(signed(periodic), { target: token, value: 0n, callData: transfer(recipient, 1n) }), stored(periodic))],
    ['a mutated caveat', /stored operator grant/, () => {
      const grant = signed(periodic)
      const mutated = { ...grant, caveats: grant.caveats.map((item, index) => index === grant.caveats.length - 1 ? { ...item, terms: `${item.terms.slice(0, -2)}ff` as Hex } : item) }
      return checkHireFunding(ctx, operator, agent, redemption(mutated, { target: token, value: 0n, callData: transfer(recipient, 1n) }), stored(periodic))
    }],
    ['a swapped signature', /signature does not match/, () => checkHireFunding(ctx, operator, agent,
      redemption({ ...signed(periodic), signature: `0x${'cd'.repeat(65)}` }, { target: token, value: 0n, callData: transfer(recipient, 1n) }), stored(periodic))],
    ['another recipient', /different recipient/, () => checkHireFunding(ctx, operator, agent, redemption(signed(periodic), { target: token, value: 0n, callData: transfer(agent, 1n) }), stored(periodic))],
    ['more than the period amount', /exceeds the permitted amount/, () => checkHireFunding(ctx, operator, agent, redemption(signed(periodic), { target: token, value: 0n, callData: transfer(recipient, 11n) }), stored(periodic))],
    ['native value on a token permission', /outside the permitted token transfer/, () => checkHireFunding(ctx, operator, agent, redemption(signed(periodic), { target: token, value: 1n, callData: transfer(recipient, 1n) }), stored(periodic))],
    ['a different exact call', /exact approved call/, () => checkHireFunding(ctx, operator, agent, redemption(signed(exact), { target: token, value: 0n, callData: transfer(recipient, 5n) }), stored(exact))],
  ] as const)('refuses %s', (_, reason, run) => {
    expect(run).toThrow(reason)
  })

  it('refuses a permission mixed into a hire, and a delegation chain', () => {
    const allowanceSpec: sdk.GrantSpec = { kind: 'allowance-once', delegator: operator, agent, token, amount: 100n, salt: 3n, start }
    const publish = encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'publish', args: [{
      approver: agent, arbitrator: operator, manifestHash: sdk.EMPTY_HASH, policyHash: sdk.EMPTY_HASH, token, reward: 100n, creatorBond: 0n, workerBond: 0n,
      deliveryDeadline: start + 3600, expiredAt: start + 7200, reviewWindow: 3600, disputeWindow: 3600, arbitrationWindow: 43200,
    }] })
    const approvalSpec: sdk.GrantSpec = { kind: 'agent-approve', delegator: agent, salt: 2n, start }
    const hire = decodeGrantBatch(buildHireBatch({ allowance: sdk.buildGrant(ctx, allowanceSpec), work: sdk.buildGrant(ctx, workSpec), approval: sdk.buildGrant(ctx, approvalSpec),
      manager: d.delegation.manager, holding: ctx.stack.holding, token, agent, amount: 100n, publish }))
    const triple = hire.map((entry, index) => {
      const spec = index === 1 ? approvalSpec : workSpec
      return { spec, checked: checkGrantCall(ctx, spec, { to: entry.execution.target, data: entry.execution.callData }) }
    })
    // The triple's first redemption carries the permission instead of the allowance.
    const swapped = [redemption(signed(periodic), { target: token, value: 0n, callData: transfer(recipient, 1n) })[0]!, triple[1]!, triple[2]!]
    expect(() => checkHireFunding(ctx, operator, agent, swapped, stored(periodic))).toThrow('on its own')
    const contextAbi = [{ type: 'tuple[]', components: [
      { name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' },
      { name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] },
      { name: 'salt', type: 'uint256' }, { name: 'signature', type: 'bytes' },
    ] }] as const
    const grant = signed(periodic)
    const chain = encodeFunctionData({ abi: sdk.delegationManagerAbi, functionName: 'redeemDelegations', args: [
      [encodeAbiParameters(contextAbi, [[{ ...grant, caveats: [...grant.caveats] }, { ...grant, caveats: [...grant.caveats] }]])],
      [`0x${'00'.repeat(32)}`], [`${token}${'00'.repeat(32)}${transfer(recipient, 1n).slice(2)}` as Hex],
    ] })
    expect(() => checkHireFunding(ctx, operator, agent, [{ spec: workSpec, checked: checkGrantCall(ctx, workSpec, { to: d.delegation.manager, data: chain }) }], stored(periodic))).toThrow()
  })

  it('is never a relay grant itself, and stores and limits like any grant', () => {
    expect(() => checkGrantCall(ctx, periodic, { to: token, data: transfer(recipient, 1n) })).toThrow('outside')
    expect(parseGrantSpec(grantSpecJson(periodic))).toEqual(periodic)
    expect(sdk.delegationHash(sdk.buildGrant(ctx, parseGrantSpec(grantSpecJson(exact))))).toBe(sdk.delegationHash(sdk.buildGrant(ctx, exact)))
    expect(sdk.grantExpiry(periodic)).toBe(start + 86_400)
    expect([sdk.grantHasCallLimit(periodic), sdk.grantHasCallLimit(exact), sdk.grantCallLimit(exact)]).toEqual([false, true, 1])
    expect(sdk.describeGrant(ctx, exact, sdk.buildGrant(ctx, exact))).toMatchObject({ kind: 'permission', delegate: agent, calls: 1, targets: [{ address: token, methods: [exactData.slice(0, 10)] }] })
  })
})
