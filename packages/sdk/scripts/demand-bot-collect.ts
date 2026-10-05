/** Gas-only collection of the bot's own jobs, using the same durable send journal as publication. */
import { type Address, encodeFunctionData, getAddress } from 'viem'
import { type Ctx, V1_GAS } from '../src/actions.ts'
import { hirelingHoldingAbi } from '../src/abi/index.ts'
import type { TxRequest, boardClient } from '../src/board-client.ts'
import { assertDemandTransactions } from '../src/demand-bot-validation.ts'
import { deferredCollectTransactions, hirelingState } from '../src/hireling.ts'
import type { DemandOperation } from './demand-bot-store.ts'
import type { FlowState } from '../src/flow-journal.ts'

const terminal = (current: Awaited<ReturnType<typeof hirelingState>>) => ['Completed', 'Rejected', 'Expired'].includes(current.job.statusName)
const settled = (current: Awaited<ReturnType<typeof hirelingState>>) => terminal(current) && !current.collectPending

export async function collectDemandOperation(input: {
  ctx: Ctx
  creator: Address
  operation: DemandOperation
  state: FlowState
  save: () => void
  board: Pick<ReturnType<typeof boardClient>, 'call'>
  send: (key: string, tx: TxRequest) => Promise<unknown>
}) {
  const { ctx, creator, operation, state, save, board, send } = input
  if (operation.jobId === undefined || operation.collection?.settledAt !== undefined) return
  const jobId = operation.jobId
  const prepared = operation.prepared
  if (prepared === undefined || getAddress(operation.intent.creator) !== getAddress(creator)) throw new Error('collection has no matching saved creator or task')
  const read = async () => {
    const current = await hirelingState(ctx, jobId)
    if (getAddress(current.listing.creator) !== getAddress(creator) || getAddress(current.listing.token) !== getAddress(operation.intent.token) || current.listing.policyHash !== prepared.termsHash) throw new Error('collection listing differs from saved demand job')
    if (terminal(current) && operation.closed === undefined) {
      operation.closed = current.job.statusName.toLowerCase()
      save()
    }
    return current
  }
  let current = await read()
  const settle: TxRequest = {
    description: 'Settle the demand job reward and bonds', chainId: ctx.deployment.chainId,
    to: ctx.stack.holding, value: '0', gas: V1_GAS.settle.toString(),
    data: encodeFunctionData({ abi: hirelingHoldingAbi, functionName: 'settle', args: [jobId] }),
  }
  const deferred = deferredCollectTransactions(ctx, jobId)
  if (operation.collection === undefined) {
    if (settled(current)) {
      operation.collection = { transactions: [], settledAt: Math.floor(Date.now() / 1000) }
      save()
      return
    }
    if (!terminal(current) && !current.deferredDecision) return
    const actions = await board.call<{ transactions: TxRequest[] }>('settlement_actions', { taskId: prepared.taskId })
    // A paused deferred decision has no available actions yet; retry discovery next tick.
    if (actions.transactions.length === 0) return
    const expected = current.deferredDecision ? deferred : [settle]
    // The authenticated collect response may append owed/refund withdrawals. Only
    // the exact permissionless job settlement prefix is authorized for this bot.
    assertDemandTransactions(actions.transactions.slice(0, expected.length), expected)
    operation.collection = { transactions: expected }
    save() // Freeze the entire ordered intent before the first signature or broadcast.
  }
  const transactions = operation.collection.transactions
  assertDemandTransactions(transactions, transactions.length === 2 ? deferred : [settle])
  for (const [index, tx] of transactions.entries()) {
    const key = `${operation.id}/collect/${index}`
    if (state.sends[key] === undefined) {
      current = await read()
      // Someone else may have collected, or completed the deferred prerequisite.
      // Never sign a new transaction for an effect the chain already records.
      if (settled(current)) continue
      const retry = transactions.length === 2 && index === 0
      if (retry && !current.deferredDecision) continue
      if (retry ? current.paused : !terminal(current)) return
    }
    // Reconcile signed bytes even if the board no longer offers their action.
    // FlowJournal refuses an independently consumed nonce and never signs again.
    await send(key, tx)
  }
  current = await read()
  if (settled(current)) {
    operation.collection.settledAt = Math.floor(Date.now() / 1000)
    save()
  }
}
