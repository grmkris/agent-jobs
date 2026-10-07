/**
 * Execution budgets as delegations (ADR-0009): a budget encoded as one MetaMask Delegation Framework (ERC-7710,
 * v1.3.0) delegation from the creator's account to the activated worker, the EIP-712 payload the creator signs, the
 * worker's redemption, the creator's revocation, and the enforcers' on-chain counters.
 *
 * Addresses come from the network's config (`deployment.delegation`). The encodings are the framework's; viem alone
 * builds them, and `delegation.test.ts` cross-checks them against MetaMask's own `@metamask/delegation-core`. The board
 * never signs: it prepares what the creator signs and what the worker sends.
 */
import type { Deployment } from '../deployment.ts'
import type { Ctx } from '../actions.ts'
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  hashStruct,
  hashTypedData,
  pad,
  parseAbi,
  parseAbiItem,
  toFunctionSelector,
} from 'viem'
import { typedDataJson } from '../typed-data.ts'

/** The authority of a delegation granted directly by the account that holds the funds (no parent delegation). */
export const ROOT_AUTHORITY: Hex = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

/** ERC-7579 execution mode: one call, revert on failure. */
const SINGLE_DEFAULT_MODE: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000'

export interface Caveat {
  readonly enforcer: Address
  readonly terms: Hex
  readonly args: Hex
}

type ExecutionBudget = AdvanceBudget | CallBudget

interface AdvanceBudget {
  readonly kind: 'advance'
  readonly token: Address
  readonly cap: bigint
  readonly expiresAt: number
}

interface CallBudget {
  readonly kind: 'call'
  readonly target: Address
  readonly function: string
  readonly cap: bigint
  readonly expiresAt: number
}

function callFunction(budget: CallBudget) {
  const item = parseAbiItem(budget.function)
  if (item.type !== 'function') throw new Error('not a function')
  return item
}

export interface Delegation {
  readonly delegate: Address
  readonly delegator: Address
  readonly authority: Hex
  readonly caveats: readonly Caveat[]
  readonly salt: bigint
  readonly signature: Hex
}

/** The framework's EIP-712 types: what the creator signs (a caveat's `args` and the signature are not signed). */
export const DELEGATION_TYPES = {
  Caveat: [
    { name: 'enforcer', type: 'address' },
    { name: 'terms', type: 'bytes' },
  ],
  Delegation: [
    { name: 'delegate', type: 'address' },
    { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'Caveat[]' },
    { name: 'salt', type: 'uint256' },
  ],
} as const

const STRUCTS = [
  'struct Caveat { address enforcer; bytes terms; bytes args; }',
  'struct Delegation { address delegate; address delegator; bytes32 authority; Caveat[] caveats; uint256 salt; bytes signature; }',
] as const

export const delegationManagerAbi = parseAbi([
  ...STRUCTS,
  'function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)',
  'function disableDelegation(Delegation delegation)',
  'function disabledDelegations(bytes32 delegationHash) view returns (bool)',
  'event RedeemedDelegation(address indexed rootDelegator, address indexed redeemer, Delegation delegation)',
])

/** The two counters a budget reads back: an advance's running total and a call budget's call count. */
const countersAbi = parseAbi([
  'function spentMap(address delegationManager, bytes32 delegationHash) view returns (uint256)',
  'function callCounts(address delegationManager, bytes32 delegationHash) view returns (uint256)',
])

/** A permission context: `abi.encode(Delegation[])`, leaf to root (here one root delegation). */
const permissionContextAbi = [
  {
    type: 'tuple[]',
    components: [
      { name: 'delegate', type: 'address' },
      { name: 'delegator', type: 'address' },
      { name: 'authority', type: 'bytes32' },
      {
        name: 'caveats',
        type: 'tuple[]',
        components: [
          { name: 'enforcer', type: 'address' },
          { name: 'terms', type: 'bytes' },
          { name: 'args', type: 'bytes' },
        ],
      },
      { name: 'salt', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
  },
] as const

const uint = (x: bigint): Hex => encodeAbiParameters([{ type: 'uint256' }], [x])
/** Terms as canonical lowercase hex (packed addresses would otherwise keep their checksum casing). */
const caveat = (enforcer: Address, terms: Hex): Caveat => ({ enforcer, terms: terms.toLowerCase() as Hex, args: '0x' })

/**
 * The delegation for one hire's budget, from `creator` to `worker`, valid while the chain's time is before `until`.
 *
 * - An advance: ERC-20 `transfer`s of `budget.token` only (target and selector pinned by the amount enforcer), all to
 *   the worker (the recipient word pinned), no native value, at most `budget.cap` in total across redemptions.
 * - A call: one call to `budget.target`'s one function, sending at most `budget.cap` of native value.
 *
 * `salt` is the offer's terms hash: one delegation per hire, so a re-prepared grant is the same delegation and a
 * revoked one stays revoked.
 */
export function budgetDelegation(
  d: Deployment,
  budget: ExecutionBudget,
  creator: Address,
  worker: Address,
  salt: Hex,
  until: number,
): Delegation {
  const e = d.delegation.enforcers
  const window = caveat(e.timestamp, encodePacked(['uint128', 'uint128'], [0n, BigInt(until)]))
  const caveats =
    budget.kind === 'advance'
      ? [
          caveat(e.valueLte, uint(0n)),
          caveat(e.erc20TransferAmount, encodePacked(['address', 'uint256'], [budget.token, budget.cap])),
          caveat(e.allowedCalldata, encodePacked(['uint256', 'bytes'], [4n, pad(worker, { size: 32 })])),
          window,
        ]
      : [
          caveat(e.allowedTargets, budget.target),
          caveat(e.allowedMethods, toFunctionSelector(callFunction(budget))),
          caveat(e.valueLte, uint(budget.cap)),
          caveat(e.limitedCalls, uint(1n)),
          window,
        ]
  return {
    delegate: worker,
    delegator: creator,
    authority: ROOT_AUTHORITY,
    caveats,
    salt: BigInt(salt),
    signature: '0x',
  }
}

function signable(x: Delegation) {
  return {
    delegate: x.delegate,
    delegator: x.delegator,
    authority: x.authority,
    caveats: x.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })),
    salt: x.salt,
  }
}

export function delegationDomain(d: Deployment) {
  return {
    name: 'DelegationManager',
    version: '1',
    chainId: d.chainId,
    verifyingContract: d.delegation.manager,
  } as const
}

/** What the enforcers key their counters by and `disabledDelegations` is indexed by: the EIP-712 struct hash. */
export function delegationHash(x: Delegation): Hex {
  return hashStruct({ data: signable(x), primaryType: 'Delegation', types: DELEGATION_TYPES })
}

/** The digest the creator signs; the DeleGator on the creator's account checks its own key against it (ERC-1271). */
export function delegationDigest(d: Deployment, x: Delegation): Hex {
  return hashTypedData({
    domain: delegationDomain(d),
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    message: signable(x),
  })
}

/** The `eth_signTypedData_v4` JSON of the delegation, for the creator's wallet. */
export function delegationTypedData(d: Deployment, x: Delegation): string {
  return typedDataJson(delegationDomain(d), DELEGATION_TYPES, 'Delegation', signable(x))
}

/** A call the delegation executes from the creator's account. */
export interface Execution {
  readonly target: Address
  readonly value: bigint
  readonly callData: Hex
}

/** The transfer an advance draw executes: `amount` of the budget token to the worker. */
export function advanceExecution(token: Address, worker: Address, amount: bigint): Execution {
  return {
    target: token,
    value: 0n,
    callData: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [worker, amount] }),
  }
}

/** `redeemDelegations` calldata for the signed delegation and one execution; the worker sends it to the manager. */
export function redeemCalldata(signed: Delegation, execution: Execution): Hex {
  return redeemCallsCalldata(signed, [execution])
}

/** ERC-7710 `permissionContext`: the ABI-encoded chain (here one root delegation) a redeemer passes to the manager. */
export function permissionContext(signed: Delegation): Hex {
  return encodeAbiParameters(permissionContextAbi, [[{ ...signed, caveats: [...signed.caveats] }]])
}

/** Atomic ordered calls through the manager. Each execution consumes one LimitedCalls count. */
export function redeemCallsCalldata(signed: Delegation, executions: readonly Execution[]): Hex {
  const context = permissionContext(signed)
  return encodeFunctionData({
    abi: delegationManagerAbi,
    functionName: 'redeemDelegations',
    args: [
      executions.map(() => context),
      executions.map(() => SINGLE_DEFAULT_MODE),
      executions.map((execution) =>
        encodePacked(['address', 'uint256', 'bytes'], [execution.target, execution.value, execution.callData]),
      ),
    ],
  })
}

/** `disableDelegation` calldata; only the delegator (the creator's account) may send it. */
export function disableCalldata(x: Delegation): Hex {
  return encodeFunctionData({
    abi: delegationManagerAbi,
    functionName: 'disableDelegation',
    args: [{ ...x, caveats: [...x.caveats] }],
  })
}

/** An advance's running total, as the ERC-20 amount enforcer counts it. */
export function drawn(ctx: Ctx, hash: Hex): Promise<bigint> {
  const d = ctx.deployment.delegation
  return ctx.publicClient.readContract({
    address: d.enforcers.erc20TransferAmount,
    abi: countersAbi,
    functionName: 'spentMap',
    args: [d.manager, hash],
  })
}

/** How many times a call budget was redeemed. */
export function callsMade(ctx: Ctx, hash: Hex): Promise<bigint> {
  const d = ctx.deployment.delegation
  return ctx.publicClient.readContract({
    address: d.enforcers.limitedCalls,
    abi: countersAbi,
    functionName: 'callCounts',
    args: [d.manager, hash],
  })
}

export function isDisabled(ctx: Ctx, hash: Hex): Promise<boolean> {
  const d = ctx.deployment.delegation
  return ctx.publicClient.readContract({
    address: d.manager,
    abi: delegationManagerAbi,
    functionName: 'disabledDelegations',
    args: [hash],
  })
}

/** The delegation as stored: JSON with the salt as a decimal string. */
export function delegationJson(x: Delegation): string {
  return JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
}

export function parseDelegation(json: string): Delegation {
  const raw = JSON.parse(json) as Omit<Delegation, 'salt'> & { salt: string }
  return { ...raw, salt: BigInt(raw.salt) }
}
