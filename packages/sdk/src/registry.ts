/** ERC-8004 registration and the new wallet's consent. The operator owns the NFT, the agent signs consent. */
import { type Address, type Hex, encodeFunctionData } from 'viem'
import { identityAbi } from './abi/index.ts'
import type { Deployment } from './deployment.ts'
import { typedDataJson } from './typed-data.ts'

export const agentWalletTypes = {
  AgentWalletSet: [
    { name: 'agentId', type: 'uint256' },
    { name: 'newWallet', type: 'address' },
    { name: 'owner', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export interface AgentWalletConsent {
  readonly agentId: bigint
  readonly newWallet: Address
  readonly owner: Address
  readonly deadline: bigint
}

export function agentWalletTypedData(d: Deployment, consent: AgentWalletConsent): string {
  return typedDataJson({ name: 'ERC8004IdentityRegistry', version: '1', chainId: d.chainId, verifyingContract: d.identity },
    agentWalletTypes, 'AgentWalletSet', consent)
}

export function registerCalldata(agentURI: string): Hex {
  if (agentURI.length === 0 || agentURI.length > 8192) throw new Error('Invalid agent URI')
  return encodeFunctionData({ abi: identityAbi, functionName: 'register', args: [agentURI] })
}

export function setAgentWalletCalldata(consent: AgentWalletConsent, signature: Hex): Hex {
  return encodeFunctionData({ abi: identityAbi, functionName: 'setAgentWallet', args: [consent.agentId, consent.newWallet, consent.deadline, signature] })
}
