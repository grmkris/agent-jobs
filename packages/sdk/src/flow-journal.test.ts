import { type Hex, type TransactionReceipt, TransactionReceiptNotFoundError, keccak256 } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import type { Ctx, Wallet } from './actions.ts'
import { FlowJournal, flowJson, parseFlowJson, type FlowState } from './flow-journal.ts'

const raw = '0x1234' as Hex, hash = keccak256(raw), address = '0x1111111111111111111111111111111111111111' as const
const receipt = { transactionHash: hash, status: 'success', logs: [] } as unknown as TransactionReceipt
const tx = { to: address, data: '0xab' as Hex, value: '0', gas: '1000000' }
function fixture() {
  let durable: FlowState = { binding: 'testnet', values: {}, sends: {} }, crashed = true
  const save = vi.fn((state: FlowState) => { durable = parseFlowJson(flowJson(state)); if (crashed && state.sends.one) throw new Error('process stopped after save') })
  const pc = { getChainId: vi.fn(async () => 10143), estimateGas: vi.fn(async () => 100_000n), getGasPrice: vi.fn(async () => 102_000_000_000n),
    getBlock: vi.fn(async () => ({ baseFeePerGas: 100_000_000_000n })), estimateMaxPriorityFeePerGas: vi.fn(async () => 2_000_000_000n),
    call: vi.fn(async () => ({ data: '0x' })),
    getTransactionCount: vi.fn(async () => 7), getTransactionReceipt: vi.fn(async (): Promise<TransactionReceipt> => { throw new TransactionReceiptNotFoundError({ hash }) }),
    sendRawTransaction: vi.fn(async () => hash), waitForTransactionReceipt: vi.fn(async () => receipt) }
  const wallet = { account: { address }, signTransaction: vi.fn(async () => raw) } as unknown as Wallet
  const ctx = { deployment: { chainId: 10143 }, publicClient: pc } as unknown as Ctx
  const boot = () => new FlowJournal(ctx, durable, save, vi.fn())
  return { pc, wallet, ctx, save, boot, restart: () => { crashed = false; return boot() }, state: () => durable }
}
describe('durable live flow sends', () => {
  it('resumes a crash after signing and saving but before broadcast using the same bytes and nonce', async () => {
    const f = fixture()
    await expect(f.boot().send('one', f.wallet, tx)).rejects.toThrow('process stopped')
    expect(f.pc.sendRawTransaction).not.toHaveBeenCalled()
    expect(f.state().sends.one).toEqual({ raw, hash, nonce: 7, wallet: address })
    f.pc.getGasPrice.mockResolvedValue(500_000_000_000n)
    await f.restart().send('one', f.wallet, tx)
    expect(f.wallet.signTransaction).toHaveBeenCalledTimes(1)
    expect(f.pc.getGasPrice).toHaveBeenCalledTimes(1)
    expect(f.pc.sendRawTransaction).toHaveBeenCalledExactlyOnceWith({ serializedTransaction: raw })
    expect(f.wallet.signTransaction).toHaveBeenCalledWith(expect.objectContaining({ gas: 135_000n, nonce: 7, chainId: 10143,
      maxFeePerGas: 200_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n }))
  })
  it('reconciles a mined transaction after a lost response without signing or broadcasting again', async () => {
    const f = fixture()
    await expect(f.boot().send('one', f.wallet, tx)).rejects.toThrow()
    f.pc.getTransactionReceipt.mockResolvedValue(receipt)
    expect(await f.restart().send('one', f.wallet, tx)).toBe(receipt)
    expect(f.pc.sendRawTransaction).not.toHaveBeenCalled()
    expect(f.wallet.signTransaction).toHaveBeenCalledTimes(1)
  })
  it('refuses an independently consumed nonce without creating another economic operation', async () => {
    const f = fixture()
    await expect(f.boot().send('one', f.wallet, tx)).rejects.toThrow()
    f.pc.getTransactionCount.mockResolvedValue(8)
    await expect(f.restart().send('one', f.wallet, tx)).rejects.toThrow('nonce was consumed')
    expect(f.pc.sendRawTransaction).not.toHaveBeenCalled()
    expect(f.wallet.signTransaction).toHaveBeenCalledTimes(1)
  })
  it('refuses mainnet and mismatched prepared transaction chains before signing', async () => {
    const f = fixture(), j = f.restart()
    f.pc.getChainId.mockResolvedValue(143)
    await expect(j.send('one', f.wallet, tx)).rejects.toThrow('restricted')
    await expect(j.transactions('two', f.wallet, [{ ...tx, description: 'wrong chain', chainId: 143 }])).rejects.toThrow('chain')
    expect(f.wallet.signTransaction).not.toHaveBeenCalled()
  })
  it('restores persisted bigints and values without repeating preparation', async () => {
    const f = fixture(), make = vi.fn(async () => ({ amount: 12n, deadline: 42 }))
    await f.restart().once('terms', make)
    expect(await f.restart().once('terms', make)).toEqual({ amount: 12n, deadline: 42 })
    expect(make).toHaveBeenCalledTimes(1)
  })
})

it('a signed but unmined transaction is not a completion marker; mined success is saved before returning', async () => {
  const f = fixture()
  await expect(f.boot().send('one', f.wallet, tx)).rejects.toThrow()
  const j = f.restart()
  expect(await j.mined('one')).toBeUndefined()
  expect(j.state.values['receipt/one']).toBeUndefined()
  expect(f.pc.sendRawTransaction).not.toHaveBeenCalled()
  f.pc.getTransactionReceipt.mockResolvedValue(receipt)
  expect(await j.mined('one')).toBe(receipt)
  expect(f.state().values['receipt/one']).toEqual(receipt)
})

it('keeps a guarded v1 payout estimate-first even with an explicit protocol fallback', async () => {
  const f = fixture()
  Object.assign(f.ctx, { stack: { kind: 'sidequest-v1', holding: tx.to, evaluator: '0x3333333333333333333333333333333333333333' } })
  await f.restart().send('v1-settle', f.wallet, tx)
  expect(f.wallet.signTransaction).toHaveBeenCalledWith(expect.objectContaining({ gas: 135_000n }))
  expect(f.pc.call).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ gas: 135_000n }))
})
