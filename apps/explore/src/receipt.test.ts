import { describe, expect, it } from 'vitest'
import type { ActivityStep } from './live-activity.ts'
import { paidTx, receiptMoney } from './receipt.ts'

const step = (s: ActivityStep['step'], at: number | null, txHash = `tx-${s}`): ActivityStep => ({
  jobId: '11',
  step: s,
  at,
  txHash,
  boardId: 'public',
  agentId: null,
})

describe('receiptMoney', () => {
  it('lists the reward, the agent’s share (paid, once paid) and a charged fee', () => {
    expect(receiptMoney({ reward: '14000000', net: '9800000', charged_fee: '4200000' }, true)).toEqual([
      { label: 'Reward', value: '14000000' },
      { label: 'Paid to the agent', value: '9800000' },
      { label: 'Fee', value: '4200000' },
    ])
    expect(receiptMoney({ reward: '10000000', net: '7000000', charged_fee: '0' }, false)).toEqual([
      { label: 'Reward', value: '10000000' },
      { label: "The agent's share", value: '7000000' },
    ])
    expect(receiptMoney({ reward: '5', net: null, charged_fee: null }, false)).toEqual([
      { label: 'Reward', value: '5' },
    ])
    expect(receiptMoney(undefined, true)).toEqual([])
  })
})

describe('paidTx', () => {
  it('is the paid step’s transaction, when loaded', () => {
    expect(paidTx([step('hired', 1), step('completed', 2, '0xpaid')])).toBe('0xpaid')
    expect(paidTx([step('hired', 1)])).toBeNull()
  })
})
