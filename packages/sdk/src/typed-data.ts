/**
 * The EIP-712 messages the contracts verify, with the exact domains they use. A mismatch here is a silent
 * `InvalidSignature` on-chain, so `typed-data.test.ts` checks every digest against the deployed contracts.
 */
import type { Address, Hex } from 'viem'

/** The creator's pick of one applicant (`SidequestHolding.Selection`). */
export interface Selection {
  readonly jobId: bigint
  readonly worker: Address
  readonly agentId: bigint
  readonly termsHash: Hex
  readonly activateBy: number
  readonly nonce: bigint
}

/** The arbitrator's decision (`JobsEvaluator.Ruling`). */
export interface Ruling {
  readonly jobId: bigint
  readonly forWorker: boolean
  readonly slashLoser: boolean
  readonly reasonHash: Hex
  readonly deadline: bigint
  readonly nonce: bigint
}

/** The core's relayable authorisation (`ERC8183WithAuthorization.Authorization`). */
export interface Authorization {
  readonly signer: Address
  readonly nonce: bigint
  readonly deadline: bigint
  readonly sig: Hex
}

export const holdingDomain = (chainId: number, holding: Address) =>
  ({ name: 'SidequestHolding', version: '1', chainId, verifyingContract: holding }) as const

export const evaluatorDomain = (chainId: number, evaluator: Address) =>
  ({ name: 'SidequestEvaluator', version: '1', chainId, verifyingContract: evaluator }) as const

export const coreDomain = (chainId: number, core: Address) =>
  ({ name: 'ERC8183', version: '1', chainId, verifyingContract: core }) as const

export const selectionTypes = {
  Selection: [
    { name: 'jobId', type: 'uint256' },
    { name: 'worker', type: 'address' },
    { name: 'agentId', type: 'uint256' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'activateBy', type: 'uint48' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

export const rulingTypes = {
  Ruling: [
    { name: 'jobId', type: 'uint256' },
    { name: 'forWorker', type: 'bool' },
    { name: 'slashLoser', type: 'bool' },
    { name: 'reasonHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

export const setBudgetTypes = {
  SetBudgetAuthorization: [
    { name: 'signer', type: 'address' },
    { name: 'jobId', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'optParamsHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint72' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export const submitTypes = {
  SubmitAuthorization: [
    { name: 'signer', type: 'address' },
    { name: 'jobId', type: 'uint256' },
    { name: 'deliverable', type: 'bytes32' },
    { name: 'optParamsHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint72' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

/** keccak256 of empty bytes: the `optParamsHash` of every authorisation Holding applies (no hook params). */
export const EMPTY_HASH: Hex = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'

/** A verifier's signed statement about the named CI checks of one commit (`JobsEvaluator.EvidenceAttestation`). */
export const evidenceTypes = {
  EvidenceAttestation: [
    { name: 'jobId', type: 'uint256' },
    { name: 'submissionHash', type: 'bytes32' },
    { name: 'policyHash', type: 'bytes32' },
    { name: 'repo', type: 'bytes32' },
    { name: 'headSha', type: 'bytes32' },
    { name: 'testedSha', type: 'bytes32' },
    { name: 'checkRunsHash', type: 'bytes32' },
    { name: 'conclusion', type: 'uint8' },
    { name: 'validUntil', type: 'uint256' },
  ],
} as const

/** `EvidenceAttestation.conclusion`: every required check completed successfully, or at least one did not. */
export const EvidenceConclusion = { Success: 1, Failure: 2 } as const

/** The EIP-712 JSON shape accepted by eth_signTypedData_v4, with bigint values as decimal strings. */
export function typedDataJson(
  domain: Record<string, unknown>,
  types: Record<string, unknown>,
  primaryType: string,
  message: unknown,
): string {
  const domainFields = [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ]
  return JSON.stringify(
    { types: { EIP712Domain: domainFields, ...types }, primaryType, domain, message },
    (_, value) => (typeof value === 'bigint' ? value.toString() : value),
  )
}
