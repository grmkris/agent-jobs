import * as sdk from '@agent-jobs/sdk'
import { decodeFunctionData, slice } from 'viem'
import { describe as group, expect, it } from 'vitest'
import { calldata, describe, execTransaction, preValidated, safeAbi } from './safe.ts'

const owner = '0x1111111111111111111111111111111111111111'
const vault = '0x2222222222222222222222222222222222222222'

group('acting as the Safe', () => {
  it('signs as a pre-validated owner: r = the owner, s = 0, v = 1', () => {
    const sig = preValidated(owner)
    expect(sig.length).toBe(2 + 65 * 2)
    expect(slice(sig, 12, 32)).toBe(owner)
    expect(slice(sig, 32, 64)).toBe(`0x${'0'.repeat(64)}`)
    expect(slice(sig, 64)).toBe('0x01')
  })
  it('wraps the inner call in execTransaction as a plain call with no refund', () => {
    const inner = calldata({ contract: 'StakeVault', to: vault, abi: sdk.stakeVaultAbi, functionName: 'revokeHolding', args: ['0x3333333333333333333333333333333333333333'] })
    const { functionName, args } = decodeFunctionData({ abi: safeAbi, data: execTransaction(owner, { to: vault, data: inner }) })
    expect(functionName).toBe('execTransaction')
    expect(args).toEqual([vault, 0n, inner, 0, 0n, 0n, 0n, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', preValidated(owner)])
  })
  it('reads a call back from its calldata, arguments by name', () => {
    const data = calldata({ contract: 'FeeSchedule', to: vault, abi: sdk.feeScheduleAbi, functionName: 'propose', args: [{ thresholds: [0n, 1n, 2n, 3n], bps: [3000, 1000, 300, 100], treasury: owner }] })
    expect(describe(sdk.feeScheduleAbi, data)).toEqual({ functionName: 'propose', args: [['s', `{ thresholds: [0, 1, 2, 3], bps: [3000, 1000, 300, 100], treasury: ${owner} }`]] })
    expect(describe(sdk.miningReserveAbi, calldata({ contract: 'MiningReserve', to: vault, abi: sdk.miningReserveAbi, functionName: 'fund', args: [0n, 5n] }))).toEqual({ functionName: 'fund', args: [['epoch', '0'], ['amount', '5']] })
  })
})
