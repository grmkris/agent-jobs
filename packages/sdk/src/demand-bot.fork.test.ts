/** Real quote-to-hire preparations, signing and receipts on a local Monad fork. */
import { DatabaseSync } from 'node:sqlite'
import { type Address, encodeFunctionData, parseAbi } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Board } from '../../board/src/service.ts'
import { fromNodeSqlite } from '../../board/src/store.ts'
import { forkEnabled, forkSetupTimeout, startHirelingFork } from '../test/hireling-fixture.ts'
import * as sdk from './index.ts'
import { type DemandQuote, chooseCheapestQuote, carryReservations, commitSpend, createDailySpend, reserveSpend, templateForSequence, utcDay } from './demand-bot.ts'
import { type DemandIntent, assertDemandTransactions, demandAcceptTransaction, validateDemandPreparation, validateDemandSelection } from './demand-bot-validation.ts'

const fork = forkEnabled ? describe : describe.skip
fork('demand creator with real board SQLite and v1 bytecode', () => {
  let f: Awaited<ReturnType<typeof startHirelingFork>>
  let db: DatabaseSync
  let board: Board
  let agentId: bigint
  let token: Address
  let now: number
  beforeAll(async () => {
    f = await startHirelingFork()
    db = new DatabaseSync(':memory:')
    now = Number((await f.ctx.publicClient.getBlock()).timestamp)
    board = new Board(fromNodeSqlite(db), { network: 'monad-testnet', contexts: { main: f.ctx }, domain: 'fork.test', uri: 'https://fork.test', manifestBaseUrl: 'https://fork.test/offers', now: () => now })
    agentId = await sdk.registerAgent(f.ctx, f.worker, 'https://hireling.xyz/demand-fork-worker')
    token = await f.deploy('MockPaymentToken', ['Mock USD', 'mUSD'])
    await f.send(token, parseAbi(['function mint(address,uint256)']), 'mint', [f.creator.account.address, 50_000_000n])
  }, forkSetupTimeout())
  afterAll(() => { db?.close(); f?.close() })

  it('validates the cheapest quote, resumes a publication without a second spend, selects and accepts', async () => {
    const creator = { address: f.creator.account.address }
    const worker = { address: f.worker.account.address }
    const template = templateForSequence(0)
    const intent: DemandIntent = {
      creator: creator.address, token, template, title: template.title, brief: template.brief,
      quoteDeadline: now + 60, deliveryDeadline: (Math.floor(now / 86400) + 1) * 86400 + 7200,
      windows: { reviewSeconds: 3600, disputeSeconds: 3600, arbitrationSeconds: 43200 }, arbitrator: f.arbitrator.account.address,
    }
    const request = await board.requestQuotes(creator, {
      title: intent.title, brief: intent.brief, acceptanceCriteria: [...template.acceptanceCriteria],
      tokens: [token], creatorBond: '0', workerBond: '0', deliveryDeadline: intent.deliveryDeadline, quoteDeadline: intent.quoteDeadline,
      windows: intent.windows, arbitrator: intent.arbitrator, requiredChecks: [], deliverable: { accepts: ['artifact'] }, idempotencyKey: 'demand-fork-request',
    })
    await board.submitQuote(worker, { requestId: request.requestId, agentId: agentId.toString(), token, amount: '3' })
    const quotes = await board.listQuotes(creator, { requestId: request.requestId })
    const chosen = chooseCheapestQuote(quotes.quotes as DemandQuote[], token, () => true)
    const spend = createDailySpend()
    reserveSpend(spend, utcDay(now), 'demand-fork', 3_000_000n)
    const prepared = await board.pickQuote(creator, { requestId: request.requestId, quoteId: chosen.quoteId, idempotencyKey: 'demand-fork-pick' })
    const expiredAt = await sdk.minExpiry(f.ctx, intent.deliveryDeadline, { reviewWindow: 3600, disputeWindow: 3600, arbitrationWindow: 43200 })
    validateDemandPreparation(f.ctx, intent, request.requestHash, chosen, prepared, expiredAt)
    const poisoned = { ...prepared, transactions: [{ ...prepared.transactions[0]!, data: encodeFunctionData({ abi: sdk.factoryTokenAbi, functionName: 'approve', args: [f.contributor.account.address, 3_000_000n] }) }, ...prepared.transactions.slice(1)] }
    expect(() => validateDemandPreparation(f.ctx, intent, request.requestHash, chosen, poisoned, expiredAt)).toThrow('frozen decision')

    let durable: sdk.FlowState = { binding: 'demand-fork', values: {}, sends: {} }
    let crash = true
    const boot = () => new sdk.FlowJournal(f.ctx, sdk.parseFlowJson(sdk.flowJson(durable)), state => {
      durable = sdk.parseFlowJson(sdk.flowJson(state))
      if (crash && state.sends['publish/1']) throw new Error('crash after persist before broadcast')
    }, () => undefined)
    await expect(boot().transactions('publish', f.creator, prepared.transactions)).rejects.toThrow('crash')
    const originalHash = durable.sends['publish/1']!.hash
    crash = false
    // Cross a UTC day after persisting the signed publication but before broadcast.
    const tomorrow = (Math.floor(now / 86400) + 1) * 86400
    await f.rpc('evm_setNextBlockTimestamp', [tomorrow])
    await f.rpc('evm_mine')
    now = tomorrow
    carryReservations(spend, utcDay(tomorrow))
    expect(spend.reserved[utcDay(tomorrow)]).toBe(3_000_000n)
    const receipts = await boot().transactions('publish', f.creator, prepared.transactions)
    expect(receipts.at(-1)!.transactionHash).toBe(originalHash)
    const nonce = await f.ctx.publicClient.getTransactionCount({ address: creator.address })
    await boot().transactions('publish', f.creator, prepared.transactions)
    expect(await f.ctx.publicClient.getTransactionCount({ address: creator.address })).toBe(nonce)
    const receiptBlock = await f.ctx.publicClient.getBlock({ blockNumber: receipts.at(-1)!.blockNumber })
    commitSpend(spend, 'demand-fork', utcDay(Number(receiptBlock.timestamp)))
    expect(spend.committed[utcDay(tomorrow)]).toBe(3_000_000n)
    const task = await board.reportTransaction(creator, { taskId: prepared.taskId, txHash: originalHash })
    const jobId = BigInt(task.jobId!)
    expect(task.chain.listingMatchesOffer).toBe(true)
    const selection = await board.selectWorker(creator, { taskId: prepared.taskId, applicationId: prepared.applicationId })
    const value = validateDemandSelection(f.ctx, selection.sign.typedData, selection.nonce, { jobId, worker: worker.address, agentId, termsHash: prepared.termsHash }, intent.deliveryDeadline - 60, now)
    const signature = await sdk.signSelection(f.ctx, f.creator, value)
    await board.submitSelection(creator, { taskId: prepared.taskId, nonce: selection.nonce, signature })
    const activation = await board.prepareActivation(worker, { taskId: prepared.taskId })
    const built = await board.buildActivation(worker, { taskId: prepared.taskId, budgetSignature: await sdk.signTypedDataJson(f.worker, activation.sign.typedData) })
    await sdk.sendAll(f.worker, f.ctx.publicClient, built.transactions)
    await sdk.submit(f.ctx, f.worker, jobId, sdk.hashText('fork-checked-image'))
    const accept = await board.approveWork(creator, { taskId: prepared.taskId })
    assertDemandTransactions(accept.transactions, [demandAcceptTransaction(f.ctx, jobId)])
    await boot().transactions('accept', f.creator, accept.transactions)
    expect((await sdk.getJob(f.ctx, jobId)).statusName).toBe('Completed')
  }, 180_000)
})
