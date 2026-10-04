import { readFileSync } from 'node:fs'
import { DELEGATION_TYPES } from '../../../board/src/delegation.ts'
import { selectionTypes, setBudgetTypes, submitTypes } from '../../src/typed-data.ts'

export const config = JSON.parse(readFileSync(new URL('../../../../contracts/config/monad-testnet.json', import.meta.url), 'utf8'))
if (config.chainId !== 10143) throw new Error('P0 requires Monad testnet 10143')

export const domainTypes = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
]

export const agentWalletTypes = {
  AgentWalletSet: [
    { name: 'agentId', type: 'uint256' },
    { name: 'newWallet', type: 'address' },
    { name: 'owner', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
}

export interface SigningShape {
  name: string
  contract: string
  types: Record<string, readonly { name: string; type: string }[]>
  primaryType: string
  field: string
  operator: string
  value: string
}

export const signingShapes: readonly SigningShape[] = [
  { name: 'AgentJobsHolding', contract: config.deployment.main.holding, types: selectionTypes,
    primaryType: 'Selection', field: 'nonce', operator: 'gte', value: '0' },
  { name: 'ERC8183', contract: config.deployment.core, types: setBudgetTypes,
    primaryType: 'SetBudgetAuthorization', field: 'signer', operator: 'eq', value: '{{wallet.address}}' },
  { name: 'ERC8183', contract: config.deployment.core, types: submitTypes,
    primaryType: 'SubmitAuthorization', field: 'signer', operator: 'eq', value: '{{wallet.address}}' },
  { name: 'DelegationManager', contract: config.delegation.manager, types: DELEGATION_TYPES,
    primaryType: 'Delegation', field: 'delegate', operator: 'eq', value: config.roles.relay },
  { name: 'ERC8004IdentityRegistry', contract: config.erc8004.identity, types: agentWalletTypes,
    primaryType: 'AgentWalletSet', field: 'newWallet', operator: 'eq', value: '{{wallet.address}}' },
]

export function schema(shape: SigningShape): { types: Record<string, readonly { name: string; type: string }[]>; primary_type: string } {
  return { types: { EIP712Domain: domainTypes, ...shape.types }, primary_type: shape.primaryType }
}

export function authorityPolicy(ownerId: string) {
  const rules = signingShapes.map((shape) => ({
    name: `Allow ${shape.primaryType}`,
    method: 'eth_signTypedData_v4',
    action: 'ALLOW',
    conditions: [
      { field_source: 'ethereum_typed_data_domain', field: 'chainId', operator: 'eq', value: '10143' },
      { field_source: 'ethereum_typed_data_domain', field: 'verifyingContract', operator: 'eq', value: shape.contract },
      { field_source: 'ethereum_typed_data_message', typed_data: schema(shape), field: shape.field,
        operator: shape.operator, value: shape.value },
    ],
  }))
  return {
    version: '1.0',
    name: 'Hireling v2 Monad testnet routine signer',
    chain_type: 'ethereum',
    owner_id: ownerId,
    rules: [
      ...rules,
      { name: 'Allow DeleGator upgrade', method: 'eth_sign7702Authorization', action: 'ALLOW',
        conditions: [{ field_source: 'ethereum_7702_authorization', field: 'contract', operator: 'eq', value: config.delegation.delegator }] },
      { name: 'Deny export', method: 'exportPrivateKey', action: 'DENY', conditions: [] },
    ],
  }
}

/** Unsupported policy fields stay explicit until the application validator and live fixtures prove them. */
export const appEnforced = [
  'EIP-712 domain name and version',
  'Selection spending limit and linkage to the frozen job',
  'SetBudgetAuthorization freshly quoted net and activated job',
  'Delegation B1/B2/B3 caveat templates, including pinned arguments',
  '7702 chain_id = 10143 (Privy documents only the contract condition)',
]
