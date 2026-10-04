import { describe, expect, it } from 'vitest'
import { deployment, stack } from '../deployment.ts'
import { buildGrant, describeGrant, periodTransferTerms } from './grants.ts'
import { agentWalletTypes } from '../registry.ts'
import { delegationHash } from './index.ts'
import { createERC20TokenPeriodTransferTerms } from '@metamask/delegation-core'
import { encodePacked } from 'viem'

const d = deployment('monad-testnet')
const ctx = { deployment: d, stack: stack(d, 'main') }
const operator = '0x1111111111111111111111111111111111111111' as const
const agent = '0x2222222222222222222222222222222222222222' as const
const now = 1_800_000_000

describe('spec v2 grant templates', () => {
  it('encodes MetaMask period terms byte-for-byte', () => {
    const token = d.rewardTokens[0]!
    const actual = periodTransferTerms(token, 25_000_000n, 604800, now)
    const expected = createERC20TokenPeriodTransferTerms({ tokenAddress: token, periodAmount: 25_000_000n, periodDuration: 604800, startDate: now })
    expect(actual).toBe(expected.toLowerCase())
    expect(actual).toBe(encodePacked(['address', 'uint256', 'uint256', 'uint256'], [token, 25_000_000n, 604800n, BigInt(now)]).toLowerCase())
  })

  it('builds an allowance pinned to the agent, token and fixed period', () => {
    const grant = buildGrant(ctx, { kind: 'allowance', delegator: operator, agent, token: d.rewardTokens[0]!, amount: 25_000_000n, salt: 1n, start: now })
    const description = describeGrant(ctx, { kind: 'allowance', delegator: operator, agent, token: d.rewardTokens[0]!, amount: 25_000_000n, salt: 1n, start: now }, grant)
    expect(description).toMatchObject({ kind: 'allowance', delegate: agent, recipient: agent, amount: '25000000', periodSeconds: 604800, expiresAt: now + 30 * 86400 })
    expect(grant.caveats.some(caveat => caveat.enforcer.toLowerCase() === d.delegation.enforcers.erc20PeriodTransfer.toLowerCase())).toBe(true)
  })

  it('does not accept a mutated grant', () => {
    const spec = { kind: 'registration' as const, delegator: operator, salt: 2n, start: now }
    const grant = buildGrant(ctx, spec)
    expect(() => describeGrant(ctx, spec, { ...grant, delegate: agent })).toThrow('approved template')
    expect(delegationHash(grant)).not.toBe(delegationHash({ ...grant, delegate: agent }))
  })

  it('publishes the ERC-8004 consent schema for the registry signer', () => {
    expect(agentWalletTypes.AgentWalletSet.map(field => field.name)).toEqual(['agentId', 'newWallet', 'owner', 'deadline'])
  })
})
