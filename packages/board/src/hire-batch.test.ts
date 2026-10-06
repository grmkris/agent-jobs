import { describe, expect, it } from 'vitest'
import { encodeFunctionData } from 'viem'
import * as sdk from '@sidequest/sdk'
import { buildHireBatch, decodeHireBatch, redeemGrantBatch } from './hire-batch.ts'

const address = (digit: string) => `0x${digit.repeat(40)}` as `0x${string}`
const grant = (delegator: `0x${string}`, delegate: `0x${string}`, salt: bigint): sdk.Delegation => ({
  delegator, delegate, authority: sdk.ROOT_AUTHORITY, salt, signature: '0x', caveats: [],
})

describe('atomic hire batch encoding', () => {
  it('keeps allowance pull, Holding approval, and publish as three ordered executions', () => {
    const manager = address('1'), holding = address('2'), token = address('3'), agent = address('4')
    const publish = encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'publish', args: [{
      approver: agent, arbitrator: holding, manifestHash: sdk.EMPTY_HASH, policyHash: sdk.EMPTY_HASH,
      token, reward: 9n, creatorBond: 0n, workerBond: 0n, deliveryDeadline: 1_800_000_000, expiredAt: 1_800_010_000,
      reviewWindow: 3600, disputeWindow: 3600, arbitrationWindow: 43200,
    }] })
    const data = buildHireBatch({ allowance: grant(manager, agent, 1n), work: grant(agent, manager, 2n), approval: grant(agent, manager, 3n), manager, holding, token, agent, amount: 9n, publish })
    const decoded = decodeHireBatch(data)
    expect(decoded.executions).toHaveLength(3)
    expect(decoded.executions[0]!.target).toBe(manager)
    expect(decoded.executions[1]!.target).toBe(token)
    expect(decoded.executions[2]!.target).toBe(holding)
    expect(decoded.executions[1]!.callData.slice(0, 10)).toBe('0x095ea7b3')
    expect(decoded.executions[1]!.callData).toContain(holding.slice(2))
  })

  it('rejects a batch with the wrong number of entries', () => {
    expect(() => redeemGrantBatch([])).toThrow('1-8')
    const grantValue = grant(address('1'), address('2'), 1n)
    const one = redeemGrantBatch([{ grant: grantValue, execution: { target: address('3'), value: 0n, callData: '0x12345678' } }])
    expect(() => decodeHireBatch(one)).toThrow('requires allowance')
  })
})
