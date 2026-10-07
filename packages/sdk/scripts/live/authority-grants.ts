/** Bounded P0 fixture grants. Product grant builders belong to P2. */
import { createRequire } from 'node:module'
import {
  type Address,
  type Hex,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  pad,
  parseAbi,
  toFunctionSelector,
} from 'viem'
import {
  ROOT_AUTHORITY,
  redeemCallsCalldata,
  type Caveat,
  type Delegation,
  type Execution,
} from '../../src/delegation/index.ts'
import { config } from '../privy/policy.ts'

const require = createRequire(new URL('../../package.json', import.meta.url))
const metamask = require('@metamask/delegation-core') as {
  createERC20TokenPeriodTransferTerms(input: {
    tokenAddress: Address
    periodAmount: bigint
    periodDuration: number
    startDate: number
  }): Hex
}

export const periodAbi = parseAbi([
  'function getAvailableAmount(bytes32 hash,address manager,bytes terms) view returns(uint256,bool,uint256)',
  'function getTermsInfo(bytes terms) pure returns(address,uint256,uint256,uint256)',
  'function periodicAllowances(address manager,bytes32 hash) view returns(uint256,uint256,uint256,uint256,uint256)',
])

export function periodTerms(token: Address, amount: bigint, duration: number, start: number): Hex {
  const terms = encodePacked(
    ['address', 'uint256', 'uint256', 'uint256'],
    [token, amount, BigInt(duration), BigInt(start)],
  )
  const reference = metamask.createERC20TokenPeriodTransferTerms({
    tokenAddress: token,
    periodAmount: amount,
    periodDuration: duration,
    startDate: start,
  })
  if (terms.toLowerCase() !== reference.toLowerCase())
    throw new Error('Period terms differ from MetaMask delegation-core')
  return terms.toLowerCase() as Hex
}

const uint = (value: bigint) => encodeAbiParameters([{ type: 'uint256' }], [value])
const caveat = (enforcer: Address, terms: Hex): Caveat => ({ enforcer, terms: terms.toLowerCase() as Hex, args: '0x' })

export function fixtureGrant(
  delegator: Address,
  delegate: Address,
  salt: bigint,
  targets: readonly Address[],
  methods: readonly string[],
  calls: number,
  expires: number,
): Delegation {
  const e = config.delegation.enforcers
  return {
    delegator,
    delegate,
    authority: ROOT_AUTHORITY,
    salt,
    signature: '0x',
    caveats: [
      caveat(e.allowedTargets, concat(targets)),
      caveat(e.allowedMethods, concat(methods.map(toFunctionSelector))),
      caveat(e.limitedCalls, uint(BigInt(calls))),
      caveat(e.timestamp, encodePacked(['uint128', 'uint128'], [0n, BigInt(expires)])),
      caveat(e.valueLte, uint(0n)),
    ],
  }
}

export function fixtureAllowance(
  operator: Address,
  agent: Address,
  token: Address,
  salt: bigint,
  start: number,
  duration: number,
): Delegation {
  const e = config.delegation.enforcers
  return {
    delegator: operator,
    delegate: agent,
    authority: ROOT_AUTHORITY,
    salt,
    signature: '0x',
    caveats: [
      caveat(e.erc20PeriodTransfer, periodTerms(token, 25_000_000n, duration, start)),
      caveat(e.allowedCalldata, encodePacked(['uint256', 'bytes'], [4n, pad(agent, { size: 32 })])),
      caveat(e.timestamp, encodePacked(['uint128', 'uint128'], [0n, BigInt(start + 30 * 86400)])),
      caveat(e.valueLte, uint(0n)),
    ],
  }
}

export function pinnedApproval(
  agent: Address,
  relay: Address,
  token: Address,
  holding: Address,
  salt: bigint,
  expires: number,
): Delegation {
  const grant = fixtureGrant(agent, relay, salt, [token], ['approve(address,uint256)'], 4, expires)
  return {
    ...grant,
    caveats: [
      ...grant.caveats,
      caveat(
        config.delegation.enforcers.allowedCalldata,
        encodePacked(['uint256', 'bytes'], [4n, pad(holding, { size: 32 })]),
      ),
    ],
  }
}

export function nestedRedemption(work: Delegation, allowance: Delegation, execution: Execution): Hex {
  return redeemCallsCalldata(work, [
    { target: config.delegation.manager, value: 0n, callData: redeemCallsCalldata(allowance, [execution]) },
  ])
}

export interface RedemptionEntry {
  grant: Delegation
  execution: Execution
}

// Each entry is single/default; the manager performs all entries atomically.
export function redemptionBatch(entries: readonly RedemptionEntry[]): Hex {
  const abi = parseAbi([
    'struct Caveat { address enforcer; bytes terms; bytes args; }',
    'struct Delegation { address delegate; address delegator; bytes32 authority; Caveat[] caveats; uint256 salt; bytes signature; }',
    'function redeemDelegations(bytes[] permissionContexts,bytes32[] modes,bytes[] executionCallDatas)',
  ])
  const context = parseAbi([
    'function context(Delegation[] grants)',
    'struct Caveat { address enforcer; bytes terms; bytes args; }',
    'struct Delegation { address delegate; address delegator; bytes32 authority; Caveat[] caveats; uint256 salt; bytes signature; }',
  ]).find((item) => item.type === 'function')!
  return encodeFunctionData({
    abi,
    functionName: 'redeemDelegations',
    args: [
      entries.map(({ grant }) => encodeAbiParameters(context.inputs, [[grant]])),
      entries.map(() => pad('0x00', { size: 32 })),
      entries.map(({ execution }) =>
        encodePacked(['address', 'uint256', 'bytes'], [execution.target, execution.value, execution.callData]),
      ),
    ],
  })
}
