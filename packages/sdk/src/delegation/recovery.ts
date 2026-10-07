import type { Address, Hex } from 'viem'
import { encodeAbiParameters, encodePacked } from 'viem'
import type { Deployment } from '../deployment.ts'
import { type Caveat, type Delegation, type Execution, ROOT_AUTHORITY } from './index.ts'

/** Build a fresh short-lived owner-controlled permission for emergency recovery. */
export function recoveryGrant(
  deployment: Deployment,
  agent: Address,
  operator: Address,
  call: Execution,
  salt: bigint,
  now: number,
): Delegation {
  if (agent.toLowerCase() === operator.toLowerCase() || !Number.isSafeInteger(now) || now <= 0 || call.value < 0n) {
    throw new Error('Invalid recovery authority')
  }
  const enforcers = deployment.delegation.enforcers
  const caveats: Caveat[] = [
    { enforcer: enforcers.allowedTargets, terms: call.target, args: '0x' },
    {
      enforcer: enforcers.valueLte,
      terms: encodeAbiParameters([{ type: 'uint256' }], [call.value]),
      args: '0x',
    },
    {
      enforcer: enforcers.timestamp,
      terms: encodePacked(['uint128', 'uint128'], [0n, BigInt(now + 600)]),
      args: '0x',
    },
    {
      enforcer: enforcers.limitedCalls,
      terms: encodeAbiParameters([{ type: 'uint256' }], [1n]),
      args: '0x',
    },
  ]
  if (call.callData !== '0x') {
    caveats.push({
      enforcer: enforcers.allowedMethods,
      terms: call.callData.slice(0, 10) as Hex,
      args: '0x',
    })
    caveats.push({
      enforcer: enforcers.allowedCalldata,
      terms: encodePacked(['uint256', 'bytes'], [0n, call.callData]),
      args: '0x',
    })
  } else if (call.target.toLowerCase() !== operator.toLowerCase()) {
    throw new Error('A native sweep must pay the operator')
  }
  return {
    delegator: agent,
    delegate: operator,
    authority: ROOT_AUTHORITY,
    salt,
    signature: '0x',
    caveats,
  }
}
