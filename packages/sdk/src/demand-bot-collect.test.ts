/** Real filesystem journal and FlowJournal; only RPC/hosted responses are test doubles. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TransactionReceipt, TransactionReceiptNotFoundError, encodeFunctionData, keccak256 } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemandRuntime } from '../scripts/demand-bot-runtime.ts'
import { type DemandOperation, openDemandStore } from '../scripts/demand-bot-store.ts'
import { hirelingHoldingAbi } from './abi/index.ts'
import { V1_GAS } from './actions.ts'
import { type TxRequest } from './board-client.ts'
import { commitSpend, reserveSpend, templateForSequence, utcDay } from './demand-bot.ts'
import { demandAcceptTransaction } from './demand-bot-validation.ts'
import { flowJson } from './flow-journal.ts'
import { deferredCollectTransactions, hirelingState } from './hireling.ts'

vi.mock('./hireling.ts', async original => ({ ...await original<typeof import('./hireling.ts')>(), hirelingState: vi.fn() }))

const paths: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const path of paths.splice(0)) rmSync(path, { recursive: true }) })
const raw = '0x021234' as const
const hash = keccak256(raw)
const receipt = { transactionHash: hash, status: 'success', logs: [], blockNumber: 100n } as unknown as TransactionReceipt
type ChainState = Awaited<ReturnType<typeof hirelingState>>

function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'hireling-demand-collect-'))
  paths.push(path)
  // Deterministic test-only identity. No env files or live credentials are loaded.
  const boot = () => createDemandRuntime(`0x${'1'.repeat(64)}`, 'http://127.0.0.1:1', path)
  const runtime = boot()
  const operation: DemandOperation = {
    id: 'demand-2', sequence: 2, jobId: 130n, closed: 'approved',
    intent: {
      creator: runtime.account.address, token: runtime.token, arbitrator: runtime.ctx.stack.evaluator,
      template: templateForSequence(0), title: 'image', brief: 'image', deliveryDeadline: 4000, quoteDeadline: 2800,
      windows: { reviewSeconds: 3600, disputeSeconds: 3600, arbitrationSeconds: 43200 },
    },
    prepared: { taskId: 'task-130', applicationId: 'application', termsHash: `0x${'2'.repeat(64)}`, transactions: [] },
  }
  runtime.store.bot.operations.push(operation)
  runtime.store.bot.nextRequestAt = Math.floor(Date.now() / 1000) + 3600
  const day = utcDay(Math.floor(Date.now() / 1000))
  reserveSpend(runtime.store.bot.spend, day, operation.id, 3_000_000n)
  commitSpend(runtime.store.bot.spend, operation.id, day)
  runtime.store.save()
  let chain = {
    job: { statusName: 'Completed' },
    listing: { creator: runtime.account.address, token: runtime.token, policyHash: operation.prepared!.termsHash },
    collectPending: true, deferredDecision: false, paused: false,
  } as ChainState
  vi.mocked(hirelingState).mockImplementation(async () => chain)
  const tx: TxRequest = {
    description: 'settle', chainId: 10143, to: runtime.ctx.stack.holding, data: encodeFunctionData({ abi: hirelingHoldingAbi, functionName: 'settle', args: [130n] }), value: '0', gas: V1_GAS.settle.toString(),
  }
  const actions = vi.fn(async () => ({ transactions: [tx] }))
  const configure = (r: ReturnType<typeof createDemandRuntime>) => {
    const client = r.ctx.publicClient
    vi.spyOn(client, 'getChainId').mockResolvedValue(10143)
    vi.spyOn(client, 'readContract').mockImplementation(async args => {
      if (args.functionName === 'symbol') return 'mUSD'
      if (args.functionName === 'decimals') return 6
      throw new Error('unexpected contract read')
    })
    vi.spyOn(client, 'estimateGas').mockResolvedValue(100_000n)
    vi.spyOn(client, 'getGasPrice').mockResolvedValue(102_000_000_000n)
    vi.spyOn(client, 'getBlock').mockResolvedValue({ baseFeePerGas: 100_000_000_000n } as never)
    vi.spyOn(client, 'estimateMaxPriorityFeePerGas').mockResolvedValue(2_000_000_000n)
    vi.spyOn(client, 'call').mockResolvedValue({ data: '0x' })
    const nonce = vi.spyOn(client, 'getTransactionCount').mockResolvedValue(7)
    const find = vi.spyOn(client, 'getTransactionReceipt').mockImplementation(async () => { throw new TransactionReceiptNotFoundError({ hash }) })
    const broadcast = vi.spyOn(client, 'sendRawTransaction').mockImplementation(async () => {
      const persisted = openDemandStore(path, r.store.state.binding, 1)
      expect(persisted.bot.operations[0]!.collection?.transactions).toEqual(r.store.bot.operations[0]!.collection?.transactions)
      expect(persisted.state.sends['demand-2/collect/0']).toMatchObject({ raw, hash, nonce: 7 })
      chain = { ...chain, collectPending: false }
      return hash
    })
    const wait = vi.spyOn(client, 'waitForTransactionReceipt').mockResolvedValue(receipt)
    const sign = vi.spyOn(r.wallet, 'signTransaction').mockImplementation(async () => {
      expect(openDemandStore(path, r.store.state.binding, 1).bot.operations[0]!.collection?.transactions.length).toBeGreaterThan(0)
      return raw
    })
    vi.spyOn(r.board, 'signIn').mockResolvedValue({ session: 'fixture' })
    const hosted = vi.spyOn(r.board, 'call').mockImplementation(async tool => {
      if (tool === 'settlement_actions') return actions()
      if (tool === 'report_transaction') return {}
      throw new Error(`unexpected hosted call ${tool}`)
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    return { nonce, find, broadcast, wait, sign, hosted }
  }
  const io = configure(runtime)
  return { runtime, operation, tx, actions, io, path, setChain: (patch: Partial<ChainState>) => { chain = { ...chain, ...patch } },
    restart: () => { const r = boot(); return { runtime: r, io: configure(r) } } }
}

describe('demand terminal collection', () => {
  it.each(['Completed', 'Rejected', 'Expired'])('sweeps an old closed %s job on the first tick and leaves the mUSD ledger unchanged', async statusName => {
    const f = fixture()
    f.setChain({ job: { statusName } as ChainState['job'] })
    const spend = flowJson(f.runtime.store.bot.spend)
    await f.runtime.tick(() => false)
    expect(f.io.hosted).toHaveBeenCalledWith('settlement_actions', { taskId: 'task-130' })
    expect(f.io.sign).toHaveBeenCalledTimes(1)
    expect(f.io.broadcast).toHaveBeenCalledTimes(1)
    expect(f.runtime.store.state.values['receipt/demand-2/collect/0']).toEqual(receipt)
    expect(f.operation.collection?.settledAt).toBeTypeOf('number')
    expect(flowJson(f.runtime.store.bot.spend)).toBe(spend)
    const restart = f.restart()
    await restart.runtime.tick(() => false)
    await restart.runtime.tick(() => false)
    expect(restart.io.sign).not.toHaveBeenCalled()
    expect(restart.io.broadcast).not.toHaveBeenCalled()
    expect(restart.io.hosted).not.toHaveBeenCalled()
    expect(flowJson(restart.runtime.store.bot.spend)).toBe(spend)
  })

  it('resumes exact bytes after a crash following durable signing but before broadcast', async () => {
    const f = fixture()
    f.io.find.mockImplementationOnce(async () => { throw new Error('process stopped after durable signature') })
    await expect(f.runtime.tick(() => false)).rejects.toThrow('process stopped')
    expect(f.io.broadcast).not.toHaveBeenCalled()
    const saved = openDemandStore(f.path, f.runtime.store.state.binding, 1)
    expect(saved.state.sends['demand-2/collect/0']).toMatchObject({ raw, hash, nonce: 7 })
    const restart = f.restart()
    f.actions.mockRejectedValue(new Error('fresh hosted actions must not be requested'))
    await restart.runtime.tick(() => false)
    expect(restart.io.sign).not.toHaveBeenCalled()
    expect(restart.io.broadcast).toHaveBeenCalledExactlyOnceWith({ serializedTransaction: raw })
    expect(f.actions).toHaveBeenCalledTimes(1)
  })

  it('reconciles a mined settlement after a lost response even when fresh actions have disappeared', async () => {
    const f = fixture()
    f.io.wait.mockRejectedValue(new Error('response lost'))
    await expect(f.runtime.tick(() => false)).rejects.toThrow('response lost')
    expect(f.operation.collection?.settledAt).toBeUndefined()
    f.actions.mockResolvedValue({ transactions: [] })
    const restart = f.restart()
    restart.io.find.mockResolvedValue(receipt)
    await restart.runtime.tick(() => false)
    expect(restart.io.sign).not.toHaveBeenCalled()
    expect(restart.io.broadcast).not.toHaveBeenCalled()
    expect(f.actions).toHaveBeenCalledTimes(1)
    expect(restart.runtime.store.state.values['receipt/demand-2/collect/0']).toEqual(receipt)
    expect(restart.runtime.store.bot.operations[0]!.collection?.settledAt).toBeTypeOf('number')
  })

  it('blocks fresh work when the saved nonce was consumed without its settlement receipt', async () => {
    const f = fixture()
    f.io.find.mockRejectedValueOnce(new Error('crash'))
    await expect(f.runtime.tick(() => false)).rejects.toThrow('crash')
    const restart = f.restart()
    restart.runtime.store.bot.nextRequestAt = 0
    restart.io.nonce.mockResolvedValue(8)
    await expect(restart.runtime.tick(() => true)).rejects.toThrow('nonce was consumed')
    expect(restart.io.sign).not.toHaveBeenCalled()
    expect(restart.io.broadcast).not.toHaveBeenCalled()
    expect(restart.io.hosted).not.toHaveBeenCalled()
    expect(restart.runtime.store.bot.sequence).toBe(0)
  })

  it('reconciles a later unfinished send before backfilling an older closed job', async () => {
    const f = fixture()
    const unfinished: DemandOperation = { ...f.operation, id: 'demand-3', jobId: 131n, accept: demandAcceptTransaction(f.runtime.ctx, 131n) }
    delete unfinished.closed
    f.runtime.store.bot.operations.push(unfinished)
    f.runtime.store.state.sends['demand-3/accept'] = { raw, hash, nonce: 7, wallet: f.runtime.account.address }
    f.runtime.store.save()
    f.io.nonce.mockResolvedValue(8)
    await expect(f.runtime.tick(() => false)).rejects.toThrow('nonce was consumed')
    expect(f.actions).not.toHaveBeenCalled()
    expect(f.io.sign).not.toHaveBeenCalled()
    expect(f.io.broadcast).not.toHaveBeenCalled()
    expect(f.operation.collection).toBeUndefined()
  })

  it('refuses a new settlement signature while another saved unbroadcast send remains unresolved', async () => {
    const f = fixture()
    f.runtime.store.state.sends['other-operation/publish/0'] = { raw, hash, nonce: 7, wallet: f.runtime.account.address }
    f.runtime.store.save()
    await expect(f.runtime.collect(f.operation)).rejects.toThrow('saved demand send requires reconciliation')
    expect(f.io.sign).not.toHaveBeenCalled()
    expect(f.io.broadcast).not.toHaveBeenCalled()
  })

  it('records an already collected job without signing or discovering actions', async () => {
    const f = fixture()
    f.setChain({ collectPending: false })
    await f.runtime.tick(() => false)
    expect(f.operation.collection).toEqual({ transactions: [], settledAt: expect.any(Number) })
    expect(f.io.sign).not.toHaveBeenCalled()
    expect(f.actions).not.toHaveBeenCalled()
  })

  it('keeps an empty board response pending while the chain still has bonds to settle', async () => {
    const f = fixture()
    f.actions.mockResolvedValue({ transactions: [] })
    await f.runtime.tick(() => false)
    expect(f.operation.collection).toBeUndefined()
    f.actions.mockResolvedValue({ transactions: [f.tx] })
    await f.runtime.tick(() => false)
    expect(f.operation.collection?.settledAt).toBeTypeOf('number')
    expect(f.io.sign).toHaveBeenCalledTimes(1)
  })

  it('reconciles an unsigned intent collected by someone else after discovery without sending', async () => {
    const f = fixture()
    f.actions.mockImplementation(async () => { f.setChain({ collectPending: false }); return { transactions: [f.tx] } })
    await f.runtime.tick(() => false)
    expect(f.operation.collection?.settledAt).toBeTypeOf('number')
    expect(f.io.sign).not.toHaveBeenCalled()
    expect(f.runtime.store.state.sends).toEqual({})
  })

  it('requires settled chain flags even after a successful receipt', async () => {
    const f = fixture()
    f.io.broadcast.mockResolvedValue(hash)
    await f.runtime.tick(() => false)
    expect(f.operation.collection?.settledAt).toBeUndefined()
    f.io.find.mockResolvedValue(receipt)
    f.setChain({ collectPending: false })
    await f.runtime.tick(() => false)
    expect(f.operation.collection?.settledAt).toBeTypeOf('number')
    expect(f.io.sign).toHaveBeenCalledTimes(1)
    expect(f.io.broadcast).toHaveBeenCalledTimes(1)
  })

  it('leaves a paused deferred decision pending without confusing it with terminal settlement', async () => {
    const f = fixture()
    f.setChain({ job: { statusName: 'Submitted' } as ChainState['job'], deferredDecision: true, paused: true, collectPending: false })
    f.actions.mockResolvedValue({ transactions: [] })
    await f.runtime.tick(() => false)
    expect(f.operation.collection).toBeUndefined()
    expect(f.io.sign).not.toHaveBeenCalled()
  })

  it.each(['target', 'job', 'value', 'chain', 'creator', 'policy'])('refuses a changed %s before signing', async mutation => {
    const f = fixture()
    const changed = { ...f.tx }
    if (mutation === 'target') changed.to = f.runtime.ctx.stack.evaluator
    if (mutation === 'job') changed.data = encodeFunctionData({ abi: hirelingHoldingAbi, functionName: 'settle', args: [131n] })
    if (mutation === 'value') changed.value = '1'
    if (mutation === 'chain') changed.chainId = 143
    if (mutation === 'creator' || mutation === 'policy') {
      const listing = { creator: f.runtime.account.address, token: f.runtime.token, policyHash: f.operation.prepared!.termsHash }
      if (mutation === 'creator') listing.creator = f.runtime.ctx.stack.evaluator
      else listing.policyHash = `0x${'3'.repeat(64)}`
      f.setChain({ listing: listing as ChainState['listing'] })
    }
    f.actions.mockResolvedValue({ transactions: [changed] })
    await expect(f.runtime.tick(() => false)).rejects.toThrow()
    expect(f.io.sign).not.toHaveBeenCalled()
    expect(f.runtime.store.state.sends).toEqual({})
  })

  it('does not send appended payout withdrawals from the authenticated collect response', async () => {
    const f = fixture()
    f.actions.mockResolvedValue({ transactions: [f.tx, { ...f.tx, data: '0xab' }] })
    await f.runtime.tick(() => false)
    expect(f.io.sign).toHaveBeenCalledTimes(1)
    expect(f.operation.collection!.transactions).toHaveLength(1)
  })

  it('reconciles saved approval before sweeping its newly terminal job', async () => {
    const f = fixture()
    delete f.operation.closed
    f.operation.accept = demandAcceptTransaction(f.runtime.ctx, 130n)
    f.runtime.store.state.sends['demand-2/accept'] = { raw, hash, nonce: 6, wallet: f.runtime.account.address }
    f.runtime.store.save()
    f.io.find.mockImplementation(async ({ hash: requested }) => {
      if (requested === hash && f.runtime.store.state.values['receipt/demand-2/accept'] === undefined) return receipt
      throw new TransactionReceiptNotFoundError({ hash: requested })
    })
    await f.runtime.tick(() => false)
    expect(f.runtime.store.state.values['receipt/demand-2/accept']).toEqual(receipt)
    expect(f.io.hosted).toHaveBeenNthCalledWith(1, 'report_transaction', { taskId: 'task-130', txHash: hash })
    expect(f.operation.closed).toBe('approved')
    expect(f.operation.collection?.settledAt).toBeTypeOf('number')
  })

  it('resumes the ordered deferred prerequisite before settling, across a restart', async () => {
    const f = fixture()
    f.setChain({ job: { statusName: 'Submitted' } as ChainState['job'], deferredDecision: true, collectPending: false })
    const deferred = deferredCollectTransactions(f.runtime.ctx, 130n)
    f.actions.mockResolvedValue({ transactions: deferred })
    f.io.broadcast.mockImplementation(async () => {
      f.setChain({ job: { statusName: 'Completed' } as ChainState['job'], deferredDecision: false, collectPending: true })
      return hash
    })
    f.io.wait.mockRejectedValue(new Error('retry response lost'))
    await expect(f.runtime.tick(() => false)).rejects.toThrow('retry response lost')
    const restart = f.restart()
    restart.io.find.mockImplementation(async () => {
      if (restart.runtime.store.state.sends['demand-2/collect/1'] === undefined) return receipt
      throw new TransactionReceiptNotFoundError({ hash })
    })
    restart.io.broadcast.mockImplementation(async () => { f.setChain({ collectPending: false }); return hash })
    await restart.runtime.tick(() => false)
    expect(restart.io.sign).toHaveBeenCalledTimes(1)
    expect(restart.io.sign).toHaveBeenCalledWith(expect.objectContaining({ to: f.tx.to, data: f.tx.data }))
    expect(restart.runtime.store.state.values['receipt/demand-2/collect/0']).toEqual(receipt)
    expect(restart.runtime.store.state.values['receipt/demand-2/collect/1']).toEqual(receipt)
    expect(restart.runtime.store.bot.operations[0]!.collection?.settledAt).toBeTypeOf('number')
  })
})
