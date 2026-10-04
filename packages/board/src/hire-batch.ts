/** Atomic S1 hire: redeem the operator allowance, approve Holding, then publish. */
import * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodePacked, erc20Abi, getAddress } from 'viem'

export interface HireBatchEntry {
  readonly grant: sdk.Delegation
  readonly execution: sdk.Execution
}

const contextAbi = [{
  type: 'tuple[]', components: [
    { name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'tuple[]', components: [
      { name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' },
    ] }, { name: 'salt', type: 'uint256' }, { name: 'signature', type: 'bytes' },
  ],
}] as const

/** Manager redemption with one independent permission context per ordered inner execution. */
export function redeemGrantBatch(entries: readonly HireBatchEntry[]): Hex {
  if (entries.length === 0 || entries.length > 8) throw new Error('A grant batch must contain 1-8 entries')
  const contexts = entries.map(entry => encodeAbiParameters(contextAbi, [[{ ...entry.grant, caveats: [...entry.grant.caveats] }]]))
  return encodeFunctionData({ abi: sdk.delegationManagerAbi, functionName: 'redeemDelegations', args: [
    contexts,
    entries.map(() => '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex),
    entries.map(entry => encodePacked(['address', 'uint256', 'bytes'], [entry.execution.target, entry.execution.value, entry.execution.callData])),
  ] })
}

export interface DecodedHireExecution {
  readonly target: Address
  readonly value: bigint
  readonly callData: Hex
}

export interface DecodedHireBatch {
  readonly executions: readonly DecodedHireExecution[]
}

function decodeExecution(data: Hex): DecodedHireExecution {
  if (!/^0x[0-9a-fA-F]+$/.test(data) || data.length < 2 + 20 * 2 + 32 * 2 + 8) throw new Error('Malformed ERC-7579 execution')
  const target = getAddress(`0x${data.slice(2, 42)}`)
  const value = BigInt(`0x${data.slice(42, 106)}`)
  const callData = `0x${data.slice(106)}` as Hex
  if (callData.length < 10) throw new Error('Execution calldata has no selector')
  return { target, value, callData }
}

/** Decode the manager call before signing or submitting it; packed execution bytes are length-delimited by the selector. */
export function decodeHireBatch(data: Hex): DecodedHireBatch {
  const executions = decodeGrantBatch(data).map(entry => entry.execution)
  if (executions.length !== 3) throw new Error('Hire batch requires allowance, approval and publish')
  return { executions }
}

/** Only canonical root grants and strict single-call execution modes enter the hosted relay. */
export function decodeGrantBatch(data: Hex): readonly HireBatchEntry[] {
  const decoded = decodeFunctionData({ abi: sdk.delegationManagerAbi, data })
  if (decoded.functionName !== 'redeemDelegations') throw new Error('Batch must redeem delegations')
  const [contexts, modes, executions] = decoded.args
  if (contexts.length === 0 || contexts.length > 8 || modes.length !== contexts.length || executions.length !== contexts.length) throw new Error('Invalid redemption array lengths')
  const entries = contexts.map((context, index) => {
    if (modes[index] !== `0x${'00'.repeat(32)}`) throw new Error('Only strict single-call redemptions are allowed')
    const grants = decodeAbiParameters(contextAbi, context)[0]
    if (grants.length !== 1 || grants[0]!.authority.toLowerCase() !== sdk.ROOT_AUTHORITY.toLowerCase()) throw new Error('Redemption requires one root grant')
    return { grant: grants[0]!, execution: decodeExecution(executions[index]!) }
  })
  if (redeemGrantBatch(entries).toLowerCase() !== data.toLowerCase()) throw new Error('Noncanonical redemption calldata')
  return entries
}

export interface HireBatchInput {
  readonly allowance: sdk.Delegation
  readonly work: sdk.Delegation
  readonly approval: sdk.Delegation
  readonly manager: Address
  readonly holding: Address
  readonly token: Address
  readonly agent: Address
  readonly amount: bigint
  readonly publish: Hex
}

/** The allowance redemption is the first inner call, so a failed publish reverts the pull and approval too. */
export function buildHireBatch(input: HireBatchInput): Hex {
  const decoded = decodeFunctionData({ abi: sdk.hirelingHoldingAbi, data: input.publish })
  if (decoded.functionName !== 'publish' || decoded.args[0].token.toLowerCase() !== input.token.toLowerCase() || decoded.args[0].reward !== input.amount || input.amount <= 0n) throw new Error('Hire funding must match the exact published reward and token')
  if (input.allowance.delegate.toLowerCase() !== input.agent.toLowerCase() || input.work.delegator.toLowerCase() !== input.agent.toLowerCase() || input.approval.delegator.toLowerCase() !== input.agent.toLowerCase()) throw new Error('Hire grants must name the same agent')
  const pull = sdk.redeemCallsCalldata(input.allowance, [sdk.advanceExecution(input.token, input.agent, input.amount)])
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [input.holding, input.amount] })
  return redeemGrantBatch([
    { grant: input.work, execution: { target: input.manager, value: 0n, callData: pull } },
    { grant: input.approval, execution: { target: input.token, value: 0n, callData: approve } },
    { grant: input.work, execution: { target: input.holding, value: 0n, callData: input.publish } },
  ])
}
