import { parseTransaction, type TransactionReceipt } from 'viem'
import type { FlowState } from '../../src/flow-journal.ts'

/** Confirmed sends cost their receipt amount; unresolved sends retain their full signed fee exposure. */
export function spentAndReserved(state: FlowState): bigint {
  return Object.entries(state.sends).reduce((sum, [label, sent]) => {
    const tx = parseTransaction(sent.raw)
    const receipt = state.values[`receipt/${label}`] as TransactionReceipt | undefined
    const gasCost = receipt === undefined ? tx.gas! * tx.maxFeePerGas! : receipt.gasUsed * receipt.effectiveGasPrice
    return sum + gasCost + (tx.value ?? 0n)
  }, 0n)
}
