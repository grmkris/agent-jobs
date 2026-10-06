import { type Hex, decodeEventLog, getAddress, isAddress, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as sdk from '../src/index.ts'
import { DEMAND_DAILY_CAP, DEMAND_INTERVAL_SECONDS, DEMAND_QUOTE_MARGIN_SECONDS, carryReservations, chooseCheapestQuote, commitSpend, demandQuotePhase, demandQuoteWindow, normalizeAddress, parseMUsdAmount, pickDemandQuoteBeforeDeadline, reserveSpend, templateForSequence, utcDay } from '../src/demand-bot.ts'
import { type DemandDescriptor, checkDemandDeliverable, demandDescriptorHash } from '../src/demand-bot-review.ts'
import { assertDemandTransactions, demandAcceptTransaction, demandCanonicalJson, validateDemandPreparation, validateDemandSelection } from '../src/demand-bot-validation.ts'
import { type DemandOperation, abandonDemandOperation, openDemandStore, persistDemandManifest } from './demand-bot-store.ts'
import { collectDemandOperation } from './demand-bot-collect.ts'

export const DEMAND_BOARD_URL = 'https://dev.sidequest.exchange'

export function demandLog(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), bot: 'demand', event, ...fields }))
}

export function safeDemandError(error: unknown): string {
  if (error instanceof sdk.BoardApiError && /^[a-zA-Z0-9_-]{1,40}$/.test(error.code)) return `board_${error.code}`
  return 'demand_step_failed'
}

interface TaskView {
  taskId: string
  jobId: string | null
  termsHash: string
  chain: { status: string; listingMatchesOffer: boolean; provider: string | null }
  deliverables: { worker: string; deliverable_hash: string; descriptor: DemandDescriptor }[]
  onchainSubmission: { deliverable_hash: string; tx_hash: Hex } | null
}

export function createDemandRuntime(key: Hex, rpc: string, directory: string) {
  const account = privateKeyToAccount(key)
  const wallet = sdk.wallet('monad-testnet', account, rpc)
  const ctx = sdk.context('monad-testnet', 'main', rpc)
  const token = ctx.deployment.rewardTokens[0]!
  const binding = demandCanonicalJson({ version: 1, chainId: 10143, creator: account.address, token, core: ctx.deployment.core, holding: ctx.stack.holding, evaluator: ctx.stack.evaluator, board: DEMAND_BOARD_URL, cap: DEMAND_DAILY_CAP, cadence: DEMAND_INTERVAL_SECONDS, templates: [templateForSequence(0), templateForSequence(1)] })
  const store = openDemandStore(directory, binding, Math.floor(Date.now() / 1000))
  const board = sdk.boardClient(DEMAND_BOARD_URL)
  const journal = new sdk.FlowJournal(ctx, store.state, store.save, (operation, hash) => demandLog('transaction', { operation, hash }))

  async function validateChain() {
    if (ctx.deployment.chainId !== 10143 || await ctx.publicClient.getChainId() !== 10143 || ctx.stack.kind !== 'sidequest-v1') throw new Error('only Monad testnet v1 is authorized')
    const [symbol, decimals] = await Promise.all([
      ctx.publicClient.readContract({ address: token, abi: sdk.factoryTokenAbi, functionName: 'symbol' }),
      ctx.publicClient.readContract({ address: token, abi: sdk.factoryTokenAbi, functionName: 'decimals' }),
    ])
    if (symbol !== 'mUSD' || decimals !== 6) throw new Error('configured demand token is not 6-decimal mUSD')
  }

  async function exclusiveSend(keyName: string, tx: Pick<sdk.TxRequest, 'to' | 'data' | 'value' | 'gas'>) {
    if (store.state.sends[keyName] === undefined) {
      // Backfilling an old terminal job must not take a nonce already saved for
      // another operation, including signed bytes not yet broadcast.
      for (const savedKey of Object.keys(store.state.sends)) {
        if (!Object.hasOwn(store.state.values, `receipt/${savedKey}`) && await journal.mined(savedKey) === undefined) throw new Error('a saved demand send requires reconciliation before a new signature')
      }
      const [latest, pending] = await Promise.all(['latest', 'pending'].map(blockTag => ctx.publicClient.getTransactionCount({ address: account.address, blockTag: blockTag as 'latest' | 'pending' })))
      if (latest !== pending) throw new Error('an external pending transaction requires reconciliation')
    }
    return journal.send(keyName, wallet, tx)
  }

  async function reconcileLiveFix() {
    const operation = store.bot.operations.find(value => value.request?.requestId === 'fbf0e1288716ad34' && value.prepared?.taskId === '5b6bb5e461f9e85f')
    if (operation === undefined || operation.closed === 'abandoned') return
    if (parseMUsdAmount(operation.quote!.amount) !== 3_000_000n || store.bot.spend.reservations[operation.id]?.amount !== 3_000_000n) throw new Error('live-fix reservation differs from reviewed operation')
    const [task, latestNonce, pendingNonce, blockNumber, code] = await Promise.all([
      board.call<TaskView>('get_task', { taskId: operation.prepared!.taskId }),
      ctx.publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' }),
      ctx.publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      ctx.publicClient.getBlockNumber(), ctx.publicClient.getCode({ address: account.address }),
    ])
    // This incident's independent EOA never sent a transaction. A new nonce or
    // delegated account code makes that no-effect proof insufficient: fail closed.
    if (task.jobId !== null || latestNonce !== 0 || pendingNonce !== 0 || (code !== undefined && code !== '0x')) throw new Error('live-fix operation needs chain reconciliation')
    const released = abandonDemandOperation(store.state, store.bot, operation, 'C2-LIVE-FIX: expired quote, verified no chain effect; never republish')
    operation.reconciliation = { at: Math.floor(Date.now() / 1000), blockNumber, latestNonce, pendingNonce, released }
    store.save()
    demandLog('abandoned', { operation: operation.id, requestId: operation.request!.requestId, taskId: operation.prepared!.taskId, releasedMUsdUnits: released.toString(), blockNumber: blockNumber.toString() })
  }

  function expireQuote(operation: DemandOperation) {
    abandonDemandOperation(store.state, store.bot, operation, 'quote-deadline-elapsed before pick; no signed sends')
    store.save()
  }

  async function newRequest(now: number) {
    const template = templateForSequence(store.bot.sequence)
    const bounds = await sdk.readWindowBounds(ctx)
    const arbitrator = await ctx.publicClient.readContract({ address: ctx.stack.holding, abi: sdk.sidequestHoldingAbi, functionName: 'defaultArbitrator' })
    const id = `demand-${store.bot.sequence}`
    const window = demandQuoteWindow(now)
    const operation: DemandOperation = {
      id, sequence: store.bot.sequence, quoteCollectionEndsAt: window.quoteCollectionEndsAt,
      intent: {
        creator: account.address, token, template,
        title: `${template.title} (${store.bot.sequence + 1})`,
        brief: `${template.brief}\nDemand operation ${id}. Deliver files in a new directory demand/${store.bot.sequence}; use a new branch. Quote only in mUSD, within the creator's remaining daily cap.`,
        deliveryDeadline: now + 3 * 3600, quoteDeadline: window.quoteDeadline,
        arbitrator, windows: { reviewSeconds: Math.max(3600, bounds.review.min), disputeSeconds: bounds.dispute.min, arbitrationSeconds: bounds.arbitration.min },
      },
    }
    store.bot.operations.push(operation)
    store.bot.sequence++
    store.bot.nextRequestAt = now + DEMAND_INTERVAL_SECONDS
    store.save()
    return operation
  }

  async function request(operation: DemandOperation) {
    if (operation.request !== undefined) return
    const intent = operation.intent
    // The saved operation and hosted idempotency key also cover a lost HTTP response.
    operation.request = await board.call('request_quotes', {
      title: intent.title, brief: intent.brief, acceptanceCriteria: intent.template.acceptanceCriteria,
      tokens: [token], creatorBond: '0', workerBond: '0', stack: 'main',
      deliveryDeadline: intent.deliveryDeadline, quoteDeadline: intent.quoteDeadline, approver: account.address,
      requiredChecks: intent.template.requiredChecks, deliverable: intent.template.deliverable,
      windows: intent.windows, arbitrator: intent.arbitrator, idempotencyKey: `${operation.id}-request`,
    })
    store.save()
    demandLog('request', { operation: operation.id, requestId: operation.request!.requestId, kind: intent.template.kind })
  }

  async function choose(operation: DemandOperation) {
    if (operation.quote !== undefined) return
    const quotes = await board.call<{ quotes: import('../src/demand-bot.ts').DemandQuote[] }>('list_quotes', { requestId: operation.request!.requestId })
    const valid = new Set<string>()
    for (const quote of quotes.quotes) {
      if (!/^\d+$/.test(quote.agentId) || !isAddress(quote.worker) || !/^0x[0-9a-fA-F]{64}$/.test(quote.quoteHash)) continue
      const worker = normalizeAddress(quote.worker)
      if ([account.address, operation.intent.arbitrator, zeroAddress].some(value => getAddress(value) === worker)) continue
      if (getAddress(await sdk.agentWallet(ctx, BigInt(quote.agentId))) === worker) valid.add(quote.quoteId)
    }
    if (valid.size === 0) {
      operation.closed = 'no-valid-quotes'
      store.save()
      return
    }
    let quote: import('../src/demand-bot.ts').DemandQuote
    try { quote = chooseCheapestQuote(quotes.quotes, token, candidate => valid.has(candidate.quoteId)) } catch {
      operation.closed = 'no-valid-quotes'
      store.save()
      return
    }
    const amount = parseMUsdAmount(quote.amount)
    const balance = await sdk.balanceOf(ctx, token, account.address)
    const day = utcDay(Math.floor(Date.now() / 1000))
    carryReservations(store.bot.spend, day)
    const used = (store.bot.spend.committed[day] ?? 0n) + (store.bot.spend.reserved[day] ?? 0n)
    if (amount > balance || used + amount > DEMAND_DAILY_CAP) {
      operation.closed = 'insufficient-budget'
      store.save()
      return
    }
    reserveSpend(store.bot.spend, day, operation.id, amount)
    operation.quote = quote
    store.save()
  }

  async function publish(operation: DemandOperation) {
    if (operation.publishedAt !== undefined) return
    if (operation.prepared === undefined) {
      const picked = await pickDemandQuoteBeforeDeadline(operation.intent.quoteDeadline, () => board.call('pick_quote', { requestId: operation.request!.requestId, quoteId: operation.quote!.quoteId, idempotencyKey: `${operation.id}-pick` }))
      if (picked === undefined) { expireQuote(operation); return }
      operation.prepared = picked
      store.save()
    }
    const prepared = await persistDemandManifest(operation, store.save, DEMAND_BOARD_URL)
    const intent = operation.intent
    const expiredAt = await sdk.minExpiry(ctx, intent.deliveryDeadline, { reviewWindow: intent.windows.reviewSeconds, disputeWindow: intent.windows.disputeSeconds, arbitrationWindow: intent.windows.arbitrationSeconds })
    validateDemandPreparation(ctx, intent, operation.request!.requestHash, operation.quote!, prepared, expiredAt)
    for (const [index, tx] of prepared.transactions.entries()) {
      // Re-reserve before every resumed/new send, including a publish that crosses midnight.
      const wallDay = utcDay(Math.floor(Date.now() / 1000))
      const chainDay = utcDay(Number((await ctx.publicClient.getBlock()).timestamp))
      carryReservations(store.bot.spend, wallDay)
      carryReservations(store.bot.spend, chainDay)
      store.save()
      const sendKey = `${operation.id}/publish/${index}`
      for (const day of new Set([wallDay, chainDay])) {
        const used = (store.bot.spend.committed[day] ?? 0n) + (store.bot.spend.reserved[day] ?? 0n)
        if (store.state.sends[sendKey] === undefined && used > DEMAND_DAILY_CAP) throw new Error('UTC cap cannot cover this unsent transaction')
      }
      const receipt = await exclusiveSend(sendKey, tx)
      await board.call('report_transaction', { taskId: prepared.taskId, txHash: receipt.transactionHash })
      if (index === prepared.transactions.length - 1) {
        for (const log of receipt.logs) {
          if (getAddress(log.address) !== getAddress(ctx.stack.holding)) continue
          try {
            const event = decodeEventLog({ abi: sdk.sidequestHoldingAbi, topics: log.topics, data: log.data })
            if (event.eventName === 'Published' && getAddress(event.args.creator) === account.address && event.args.policyHash === prepared.termsHash) operation.jobId = event.args.jobId
          } catch { /* Other Holding events. */ }
        }
        if (operation.jobId === undefined) throw new Error('exact publication event was not found')
        const block = await ctx.publicClient.getBlock({ blockNumber: receipt.blockNumber })
        operation.publishedAt = Number(block.timestamp)
        commitSpend(store.bot.spend, operation.id, utcDay(operation.publishedAt))
        store.save()
      }
    }
  }

  async function select(operation: DemandOperation, now: number) {
    if (operation.selected) return
    if (now >= operation.intent.deliveryDeadline - 60 && operation.selection === undefined) {
      operation.closed = 'activation-deadline-elapsed'
      store.save()
      return
    }
    const prepared = operation.prepared!
    const task = await board.call<TaskView>('get_task', { taskId: prepared.taskId })
    if (task.jobId === null || operation.jobId !== BigInt(task.jobId) || !task.chain.listingMatchesOffer || task.termsHash !== prepared.termsHash) throw new Error('published listing differs from prepared offer')
    const listing = await sdk.getV1Listing(ctx, operation.jobId)
    const intent = operation.intent
    sdk.assertActivationTerms(listing, { creator: account.address, approver: account.address, token, reward: parseMUsdAmount(operation.quote!.amount), creatorBond: 0n, workerBond: 0n, arbitrator: intent.arbitrator, deliveryDeadline: intent.deliveryDeadline, reviewWindow: intent.windows.reviewSeconds, disputeWindow: intent.windows.disputeSeconds, arbitrationWindow: intent.windows.arbitrationSeconds })
    if (listing.policyHash !== prepared.termsHash || getAddress(await sdk.agentWallet(ctx, BigInt(operation.quote!.agentId))) !== normalizeAddress(operation.quote!.worker)) throw new Error('selected offer or agent wallet changed')
    if (operation.selection === undefined) {
      const picked = await board.call<{ nonce: string; sign: { typedData: string } }>('select_worker', { taskId: prepared.taskId, applicationId: prepared.applicationId })
      const value = validateDemandSelection(ctx, picked.sign.typedData, picked.nonce, { jobId: operation.jobId, worker: normalizeAddress(operation.quote!.worker), agentId: BigInt(operation.quote!.agentId), termsHash: prepared.termsHash }, operation.intent.deliveryDeadline - 60, now)
      operation.selection = { nonce: picked.nonce, value, signature: await sdk.signSelection(ctx, wallet, value) }
      store.save()
    }
    await board.call('submit_selection', { taskId: prepared.taskId, nonce: operation.selection.nonce, signature: operation.selection.signature })
    operation.selected = true
    store.save()
    demandLog('selected', { operation: operation.id, taskId: prepared.taskId, jobId: task.jobId, worker: operation.quote!.worker, reward: operation.quote!.amount })
  }

  async function review(operation: DemandOperation) {
    const prepared = operation.prepared!
    if (operation.accept !== undefined) {
      // A saved, already checked decision is resumed even if the accept receipt made the job terminal.
      const receipt = await exclusiveSend(`${operation.id}/accept`, operation.accept)
      await board.call('report_transaction', { taskId: prepared.taskId, txHash: receipt.transactionHash })
      operation.closed = 'approved'
      store.save()
      return
    }
    const jobId = operation.jobId!
    const [task, job, listing] = await Promise.all([
      board.call<TaskView>('get_task', { taskId: prepared.taskId }), sdk.getJob(ctx, jobId), sdk.getV1Listing(ctx, jobId),
    ])
    if (['Completed', 'Rejected', 'Expired'].includes(job.statusName)) {
      operation.closed = job.statusName.toLowerCase()
      store.save()
      return
    }
    if (job.statusName !== 'Submitted' || task.chain.status !== 'submitted') return
    if (!task.chain.listingMatchesOffer || task.termsHash !== prepared.termsHash || listing.policyHash !== prepared.termsHash || getAddress(listing.creator) !== account.address || getAddress(listing.approver) !== account.address || getAddress(job.provider) !== normalizeAddress(operation.quote!.worker)) throw new Error('review listing or provider mismatch')
    const submission = task.onchainSubmission
    if (submission === null) return
    const deliverable = task.deliverables.find(value => value.deliverable_hash === submission.deliverable_hash && normalizeAddress(value.worker) === getAddress(job.provider))
    if (deliverable === undefined || demandDescriptorHash(deliverable.descriptor) !== submission.deliverable_hash) return
    if ((operation.intent.template.kind === 'image') !== (deliverable.descriptor.kind === 'artifact')) return
    const submittedReceipt = await ctx.publicClient.getTransactionReceipt({ hash: submission.tx_hash })
    if (submittedReceipt.status !== 'success') return
    const matched = submittedReceipt.logs.some(log => {
      if (getAddress(log.address) !== getAddress(ctx.deployment.core)) return false
      try {
        const event = decodeEventLog({ abi: sdk.coreAbi, topics: log.topics, data: log.data })
        return event.eventName === 'JobSubmitted' && event.args.jobId === jobId && getAddress(event.args.provider) === getAddress(job.provider) && event.args.deliverable === submission.deliverable_hash
      } catch { return false }
    })
    if (!matched) return
    let passed = false
    try { passed = await checkDemandDeliverable(deliverable.descriptor) } catch { /* Unavailable checks leave the review untouched. */ }
    operation.review = passed ? 'automated-check-passed' : 'automated-check-failed-or-unavailable'
    store.save()
    if (!passed) return
    const expected = demandAcceptTransaction(ctx, jobId)
    const approval = await board.call<{ transactions: sdk.TxRequest[] }>('approve_work', { taskId: prepared.taskId })
    assertDemandTransactions(approval.transactions, [expected])
    operation.accept = expected
    store.save()
    await review(operation)
  }

  const collect = (operation: DemandOperation) => collectDemandOperation({ ctx, creator: account.address, operation, state: store.state, save: store.save, board, send: exclusiveSend })

  async function tick(allowNew: () => boolean) {
    await validateChain()
    await board.signIn(account)
    await reconcileLiveFix()
    const now = Math.floor(Date.now() / 1000)
    carryReservations(store.bot.spend, utcDay(now))
    store.save()
    // Any ambiguous send interrupts this tick before a fresh request or another signature.
    const pending = (operation: DemandOperation) => Object.keys(store.state.sends).some(sendKey => sendKey.startsWith(`${operation.id}/`) && !Object.hasOwn(store.state.values, `receipt/${sendKey}`))
    for (const operation of store.bot.operations.toSorted((a, b) => Number(pending(b)) - Number(pending(a)))) {
      // Resume a saved approval first, then sweep even previously closed jobs.
      if (operation.accept !== undefined && operation.closed === undefined) await review(operation)
      await collect(operation)
      if (operation.closed !== undefined) continue
      if (operation.quote === undefined && now >= operation.intent.deliveryDeadline - 60) {
        operation.closed = 'request-expired'
        store.save()
        continue
      }
      await request(operation)
      if (operation.quote === undefined) {
        const phase = demandQuotePhase(operation.quoteCollectionEndsAt ?? operation.intent.quoteDeadline - DEMAND_QUOTE_MARGIN_SECONDS, operation.intent.quoteDeadline, Math.floor(Date.now() / 1000))
        if (phase === 'collect') continue
        if (phase === 'expired') { expireQuote(operation); continue }
      }
      await choose(operation)
      if (operation.closed !== undefined) continue
      await publish(operation)
      if (operation.closed !== undefined) continue
      await select(operation, now)
      if (operation.closed !== undefined) continue
      await review(operation)
      await collect(operation)
    }
    const latestNow = Math.floor(Date.now() / 1000)
    const day = utcDay(latestNow)
    carryReservations(store.bot.spend, day)
    store.save()
    const used = (store.bot.spend.committed[day] ?? 0n) + (store.bot.spend.reserved[day] ?? 0n)
    if (allowNew() && latestNow >= store.bot.nextRequestAt && used < DEMAND_DAILY_CAP) await request(await newRequest(latestNow))
  }

  return { account, wallet, ctx, token, store, board, journal, validateChain, reconcileLiveFix, collect, tick }
}
