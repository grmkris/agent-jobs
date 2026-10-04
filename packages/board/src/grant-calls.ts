/** Call and nested funding checks shared by the executor and sponsor desk, before simulation or signing. */
import * as sdk from '@agent-jobs/sdk'
import { type AbiFunction, type Address, type Hex, decodeFunctionData, encodeFunctionData, getAddress, isAddress, toFunctionSelector } from 'viem'
import { decodeGrantBatch } from './hire-batch.ts'

export interface GrantCall {
  readonly to: string
  readonly data: string
  readonly value?: string
  readonly chainId?: number
}

export interface CheckedGrantCall {
  readonly execution: sdk.Execution
  readonly method: string
  readonly args: readonly unknown[]
  readonly floor: bigint
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function checkGrantCall(ctx: sdk.GrantContext, spec: sdk.GrantSpec, call: GrantCall): CheckedGrantCall {
  if (!isAddress(call.to) || !/^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{2})*$/.test(call.data) || call.data.length > 32770) throw new Error('Malformed grant call')
  if ((call.value ?? '0') !== '0' || call.chainId !== undefined && call.chainId !== ctx.deployment.chainId) throw new Error('Grant calls must have zero value and use this chain')
  const target = sdk.grantTargets(ctx, spec).find(candidate => same(candidate.address, call.to))
  const fn = target?.abi.find((item): item is AbiFunction => item.type === 'function' && target.methods.includes(item.name) && same(toFunctionSelector(item), call.data.slice(0, 10)))
  if (target === undefined || fn === undefined) throw new Error('Call is outside the grant target and method policy')
  if (spec.kind === 'registration' && fn.name === 'register' && fn.inputs.length !== 1) throw new Error('Registration requires the recorded URI')
  const decoded = decodeFunctionData({ abi: [fn], data: call.data as Hex })
  if (!same(encodeFunctionData({ abi: [fn], functionName: decoded.functionName, args: decoded.args }), call.data)) throw new Error('Call is not valid canonical calldata')
  const args = decoded.args ?? []
  const pin = spec.kind === 'agent-approve' ? ctx.stack.holding : spec.kind === 'agent-sweep' ? spec.operator
    : spec.kind === 'allowance' || spec.kind === 'allowance-once' ? spec.agent : undefined
  if (pin !== undefined && (typeof args[0] !== 'string' || !same(args[0], pin))) throw new Error('Grant spender or recipient mismatch')
  if (spec.kind === 'allowance-once' && args[1] !== spec.amount) throw new Error('One-off allowance amount mismatch')
  if (fn.name === 'disableDelegation') {
    const disabled = args[0] as sdk.Delegation
    if (!same(disabled.delegator, spec.delegator)) throw new Error('Cannot disable another wallet delegation')
  }
  const floor = fn.name === 'publish' ? 1_000_000n : fn.name === 'redeemDelegations' ? 800_000n
    : fn.name === 'retryDeferred' ? sdk.V1_GAS.retryDeferred : fn.name === 'settle' ? sdk.V1_GAS.settle
    : same(target.address, ctx.stack.evaluator) ? sdk.V1_GAS.evaluator : 500_000n
  return { execution: { target: getAddress(call.to), value: 0n, callData: call.data.toLowerCase() as Hex }, method: decoded.functionName, args, floor }
}

/** The only hosted nested redemption is a matched allowance/approve/publish triple. */
export function checkHireFunding(ctx: sdk.GrantContext, operator: Address, agent: Address,
  calls: readonly { readonly spec: sdk.GrantSpec; readonly checked: CheckedGrantCall }[],
  allowanceFor: (hash: Hex) => { readonly spec: sdk.GrantSpec; readonly grant: sdk.Delegation }): number {
  let publishes = 0
  for (let index = 0; index < calls.length; index++) {
    const current = calls[index]!
    if (current.checked.method === 'approve') {
      if (calls[index - 1]?.checked.method !== 'redeemDelegations' || calls[index + 1]?.checked.method !== 'publish') throw new Error('Approval requires the atomic hire triple')
    }
    if (current.checked.method === 'publish') {
      if (calls[index - 2]?.checked.method !== 'redeemDelegations' || calls[index - 1]?.checked.method !== 'approve') throw new Error('Publish requires the atomic hire triple')
      publishes++
    }
    if (current.checked.method !== 'redeemDelegations') continue
    const approval = calls[index + 1], publish = calls[index + 2]
    if (current.spec.kind !== 'agent-work' || approval?.spec.kind !== 'agent-approve' || publish?.spec.kind !== 'agent-work'
      || approval.checked.method !== 'approve' || publish.checked.method !== 'publish') throw new Error('Nested allowance requires work, approval and publish entries')
    const inner = decodeGrantBatch(current.checked.execution.callData)
    if (inner.length !== 1) throw new Error('Allowance redemption must contain one transfer')
    const nested = inner[0]!
    const stored = allowanceFor(sdk.delegationHash(nested.grant))
    if (!['allowance', 'allowance-once'].includes(stored.spec.kind) || !same(nested.grant.delegator, operator) || !same(nested.grant.delegate, agent)
      || !same(sdk.delegationHash(nested.grant), sdk.delegationHash(stored.grant))) throw new Error('Nested allowance does not match the stored operator grant')
    if (nested.grant.signature.toLowerCase() !== stored.grant.signature.toLowerCase()) throw new Error('Nested allowance signature does not match the stored operator grant')
    sdk.assertGrant(ctx, stored.spec, nested.grant)
    const transfer = checkGrantCall(ctx, stored.spec, { to: nested.execution.target, data: nested.execution.callData, value: nested.execution.value.toString() })
    const params = publish.checked.args[0] as { token: Address; reward: bigint }
    if (!same(transfer.execution.target, params.token) || transfer.args[1] !== params.reward || !same(approval.checked.execution.target, params.token)
      || approval.checked.args[1] !== params.reward) throw new Error('Allowance pull and approval must equal the published reward and token')
    if (!same(publish.checked.execution.target, ctx.stack.holding)) throw new Error('Publish targets another Holding')
    index += 2
    publishes++
  }
  return publishes
}
