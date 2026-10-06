import { type Hex, type TransactionReceipt, BaseError, ContractFunctionRevertedError, TransactionReceiptNotFoundError, decodeFunctionData, encodeErrorResult, keccak256, slice, zeroAddress } from 'viem'
import { expect, it, vi } from 'vitest'
import * as sdk from './index.ts'
import { coreAbi, sidequestEvaluatorAbi, stakeVaultAbi } from './abi/index.ts'
import { context } from './client.ts'
import { flowPauseBatch, isHoldingTimelockRevert } from './v1-admin-flows.ts'

const timelockError = (eta: number) => new BaseError('simulation refused', { cause: new ContractFunctionRevertedError({
  abi: stakeVaultAbi, data: encodeErrorResult({ abi: stakeVaultAbi, errorName: 'HoldingTimelocked', args: [eta] }), functionName: 'acceptHolding',
}) })
it('only accepts the decoded vault timelock selector with the proposal ETA', () => {
  expect(isHoldingTimelockRevert(timelockError(200), 200)).toBe(true)
  expect(isHoldingTimelockRevert(timelockError(201), 200)).toBe(false)
  for (const error of [new Error('HoldingTimelocked'), new BaseError('RPC unavailable'),
    new ContractFunctionRevertedError({ abi: stakeVaultAbi, data: encodeErrorResult({ abi: stakeVaultAbi, errorName: 'NoHoldingProposed' }), functionName: 'acceptHolding' }),
    new ContractFunctionRevertedError({ abi: coreAbi, data: encodeErrorResult({ abi: coreAbi, errorName: 'EnforcedPause' }), functionName: 'acceptHolding' }),
  ]) expect(isHoldingTimelockRevert(error, 200)).toBe(false)
})

it('pause and notePause are one MultiSendCallOnly payload containing exactly two ordinary calls', () => {
  const ctx = context('monad-testnet', 'main', 'http://127.0.0.1:1')
  for (const pause of [true, false]) {
    const data = flowPauseBatch(ctx, pause)
    // The ABI envelope starts with multiSend selector, offset and length; each packed inner call is 89 bytes.
    const packed = slice(data, 68, 246)
    expect(slice(packed, 0, 1)).toBe('0x00')
    expect(slice(packed, 1, 21).toLowerCase()).toBe(ctx.deployment.core.toLowerCase())
    expect(decodeFunctionData({ abi: coreAbi, data: slice(packed, 85, 89) }).functionName).toBe(pause ? 'pause' : 'unpause')
    expect(slice(packed, 89, 90)).toBe('0x00')
    expect(slice(packed, 90, 110).toLowerCase()).toBe(ctx.stack.evaluator.toLowerCase())
    expect(decodeFunctionData({ abi: sidequestEvaluatorAbi, data: slice(packed, 174, 178) }).functionName).toBe('notePause')
  }
})

it.each(['admin-pause', 'admin-vault-refusal'] as const)('%s resumes after its final receipt before done, with no new signature or broadcast', async flow => {
  const base = context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const h = { safe: base.stack.holding, vault: base.stack.evaluator } as NonNullable<sdk.Deployment['sidequest']>
  let paused = false, cancelled = false, nonce = 0, interrupt = true
  let durable: sdk.FlowState = { binding: 'admin', values: {}, sends: {} }
  const receipts = new Map<Hex, TransactionReceipt>()
  const pc = { ...base.publicClient,
    getChainId: vi.fn(async () => 10143), getCode: vi.fn(async () => '0xab'), getBlock: vi.fn(async () => ({ timestamp: 100n, baseFeePerGas: 100_000_000_000n })),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'isOwner') return true
      if (functionName === 'getThreshold') return 1n
      if (functionName === 'paused') return paused
      if (functionName === 'pendingHolding') return cancelled ? [zeroAddress, 0] : [base.stack.holding, 200]
      throw new Error('unexpected read')
    }),
    simulateContract: vi.fn(async () => { throw timelockError(200) }),
    estimateGas: vi.fn(async () => 100_000n), getGasPrice: vi.fn(async () => 102_000_000_000n), getTransactionCount: vi.fn(async () => nonce),
    estimateMaxPriorityFeePerGas: vi.fn(async () => 2_000_000_000n), call: vi.fn(async () => ({ data: '0x' })),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const found = receipts.get(hash)
      if (found === undefined) throw new TransactionReceiptNotFoundError({ hash })
      return found
    }),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const hash = keccak256(serializedTransaction)
      if (flow === 'admin-pause') paused = nonce === 0
      else cancelled = true
      nonce++
      receipts.set(hash, { transactionHash: hash, status: 'success', logs: [] } as unknown as TransactionReceipt)
      return hash
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => receipts.get(hash)!),
  }
  const ctx = { ...base, stack: { ...base.stack, kind: 'sidequest-v1' }, deployment: { ...base.deployment, sidequest: h }, publicClient: pc } as unknown as sdk.Ctx
  const wallet = { account: { address: base.stack.holding }, signTransaction: vi.fn(async () => `0x${nonce.toString(16).padStart(8, '0')}`) } as unknown as sdk.Wallet
  const final = `${flow}/${flow === 'admin-pause' ? 'unpause-note' : 'cancel-probe'}`
  const boot = () => new sdk.FlowJournal(ctx, sdk.parseFlowJson(sdk.flowJson(durable)), state => {
    durable = sdk.parseFlowJson(sdk.flowJson(state))
    if (interrupt && state.values[`receipt/${final}`]) throw new Error('crash after final receipt')
  }, () => undefined)
  const deps = { ctx, creator: wallet, worker: wallet, relay: wallet, arbitrator: wallet, safeOwner: wallet, agentId: 1n, token: base.stack.factory, reward: 1n, bond: 1n, waitUntil: async () => undefined, log: () => undefined }
  await expect(sdk.runV1AdminFlow({ ...deps, journal: boot() }, flow)).rejects.toThrow('crash after final receipt')
  expect(durable.values[`${flow}/done`]).toBeUndefined()
  const signatures = vi.mocked(wallet.signTransaction).mock.calls.length, broadcasts = pc.sendRawTransaction.mock.calls.length
  interrupt = false
  await sdk.runV1AdminFlow({ ...deps, journal: boot() }, flow)
  expect(durable.values[`${flow}/done`]).toBe(true)
  expect(wallet.signTransaction).toHaveBeenCalledTimes(signatures)
  expect(pc.sendRawTransaction).toHaveBeenCalledTimes(broadcasts)
  // Final readbacks remain active on resume.
  expect(pc.readContract.mock.calls.at(-1)?.[0].functionName).toBe(flow === 'admin-pause' ? 'paused' : 'pendingHolding')
})
