import { describe, expect, it } from 'vitest'
import { decodeFunctionData } from 'viem'
import { deployment } from './deployment.ts'
import { agentWalletTypedData, registerCalldata, setAgentWalletCalldata } from './registry.ts'
import { identityAbi } from './abi/index.ts'

const d = deployment('monad-testnet')
const consent = { agentId: 7n, newWallet: '0x2222222222222222222222222222222222222222' as const, owner: '0x1111111111111111111111111111111111111111' as const, deadline: 1_800_000_100n }

describe('ERC-8004 registry helpers', () => {
  it('builds registration and wallet consent calldata', () => {
    expect(decodeFunctionData({ abi: identityAbi, data: registerCalldata('https://hireling.xyz/a') }).functionName).toBe('register')
    expect(decodeFunctionData({ abi: identityAbi, data: setAgentWalletCalldata(consent, '0x1234') }).functionName).toBe('setAgentWallet')
  })

  it('uses the deployed ERC8004IdentityRegistry domain and portable consent fields', () => {
    const typed = JSON.parse(agentWalletTypedData(d, consent)) as { domain: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }
    expect(typed.domain).toMatchObject({ name: 'ERC8004IdentityRegistry', version: '1', chainId: 10143, verifyingContract: d.identity })
    expect(typed.primaryType).toBe('AgentWalletSet')
    expect(typed.message).toMatchObject({ agentId: '7', newWallet: consent.newWallet, owner: consent.owner, deadline: '1800000100' })
  })
})
