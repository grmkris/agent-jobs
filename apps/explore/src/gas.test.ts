import * as sdk from '@agent-jobs/sdk'
import { encodeFunctionData } from 'viem'
import { describe, expect, it } from 'vitest'
import { BATCH_CALL_DEFAULT, BATCH_OVERHEAD, batchGasLimit, gasLimit } from './gas.ts'

const v1 = { holding: '0x1000000000000000000000000000000000000001', evaluator: '0x1000000000000000000000000000000000000002' }
const other = '0x2000000000000000000000000000000000000001'
const settle = encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'settle', args: [7n] })
const refund = encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'claimTopUpRefund', args: [7n, other] })
const silence = encodeFunctionData({ abi: sdk.hirelingEvaluatorAbi, functionName: 'completeAfterSilence', args: [7n] })
const retry = encodeFunctionData({ abi: sdk.hirelingEvaluatorAbi, functionName: 'retryDeferred', args: [7n] })

describe('v1 gas floors', () => {
  it('sends payout calls to the v1 contracts with at least their measured limit', () => {
    expect(gasLimit({ to: v1.holding, data: settle }, v1)).toBe(1_000_000n)
    expect(gasLimit({ to: v1.holding, data: refund }, v1)).toBe(450_000n)
    expect(gasLimit({ to: v1.evaluator, data: silence }, v1)).toBe(1_200_000n)
    expect(gasLimit({ to: v1.evaluator, data: retry }, v1)).toBe(300_000n)
    expect(gasLimit({ to: v1.holding, data: encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'cancel', args: [7n] }) }, v1)).toBe(700_000n)
    expect(gasLimit({ to: v1.holding, data: settle, gas: '700000' }, v1)).toBe(1_000_000n)
    expect(gasLimit({ to: v1.holding, data: settle, gas: '1200000' }, v1)).toBe(1_200_000n)
  })
  it('leaves every other call to the wallet, so it is not charged a bigger limit', () => {
    expect(gasLimit({ to: other, data: settle }, v1)).toBeUndefined()
    expect(gasLimit({ to: v1.holding, data: '0x095ea7b3' }, v1)).toBeUndefined()
    expect(gasLimit({ to: other, data: '0x01', gas: '90000' }, v1)).toBe(90_000n)
  })
  it('limits a batch only when a call in it has a limit, budgeting every call', () => {
    // An approval before a floored call gets its own budget, not the batch overhead.
    expect(batchGasLimit([{ to: other, data: '0x01' }, { to: v1.holding, data: refund }], v1)).toBe(BATCH_CALL_DEFAULT + 450_000n + BATCH_OVERHEAD)
    expect(batchGasLimit([{ to: other, data: '0x01' }], v1)).toBeUndefined()
    // A deferred decision's collect step: retry it on the Evaluator, then settle on the Holding.
    expect(batchGasLimit([{ to: v1.evaluator, data: retry }, { to: v1.holding, data: settle }], v1)).toBe(300_000n + 1_000_000n + BATCH_OVERHEAD)
  })
})
