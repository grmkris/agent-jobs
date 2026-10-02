/** Operation reconciliation uses verified contract events, including calls relayed through a DeleGator. */
import * as sdk from '@agent-jobs/sdk'
import { type Abi, type TransactionReceipt, decodeEventLog } from 'viem'
import { evaluatorAbi, holdingAbi } from './hireling.ts'
import type { OperationRow } from './store.ts'

const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

export async function confirmedOperationIds(ctx: sdk.Ctx, jobId: bigint, receipt: TransactionReceipt, operations: readonly OperationRow[]): Promise<string[]> {
  if (receipt.status !== 'success') return []
  const confirmed = new Set<string>()
  let listing: Awaited<ReturnType<typeof sdk.getListing>> | undefined
  const mark = (kind: string, actor: unknown, details: Array<[string, unknown]> = []) => {
    for (const op of operations) {
      if (op.kind !== kind || !same(actor, op.actor)) continue
      const prepared = op.detail === null ? {} : JSON.parse(op.detail) as Record<string, unknown>
      if (details.some(([key, value]) => {
        const expected = key === 'violation' && typeof prepared[key] === 'string' ? sdk.Violation[prepared[key] as sdk.ViolationName] : prepared[key]
        return expected === undefined || expected === null || String(expected).toLowerCase() !== String(value).toLowerCase()
      })) continue
      confirmed.add(op.id)
    }
  }
  for (const log of receipt.logs) {
    let abi: Abi
    if (same(log.address, ctx.stack.holding)) abi = holdingAbi(ctx)
    else if (same(log.address, ctx.stack.evaluator)) abi = evaluatorAbi(ctx)
    else if (same(log.address, ctx.deployment.core)) abi = sdk.coreAbi
    else continue
    let event: { eventName: string; args?: Record<string, unknown> }
    try { event = decodeEventLog({ abi, data: log.data, topics: log.topics }) as unknown as typeof event } catch { continue }
    const a = event.args ?? {}
    if (a.jobId !== jobId) continue
    switch (event.eventName) {
      case 'Activated': mark('activate', a.worker, [['selectionNonce', a.selectionNonce]]); break
      case 'ToppedUp': mark('top-up', a.contributor, [['amount', a.amount]]); break
      case 'JobSubmitted': mark('submit', a.provider, [['deliverableHash', a.deliverable]]); break
      case 'Accepted': mark('accept', a.approver); break
      case 'Rejected': mark('reject', a.approver, [['reasonHash', a.reasonHash], ['violation', a.violation]]); break
      case 'Disputed': mark('dispute', a.worker); break
      case 'Ruled': {
        const actor = a.arbitrator ?? await ctx.publicClient.readContract({ address: ctx.stack.evaluator, abi: sdk.jobsEvaluatorAbi, functionName: 'arbitrator' })
        mark('rule', actor, [['reasonHash', a.reasonHash], ['forWorker', a.forWorker], ['slashLoser', a.slashLoser]]); break
      }
      case 'Cancelled': {
        listing ??= await sdk.getListing(ctx, jobId)
        mark('cancel', listing.creator); break
      }
      case 'Awarded': {
        listing ??= await sdk.getListing(ctx, jobId)
        mark('award', listing.approver, [['worker', a.worker], ['agentId', a.agentId], ['deliverableHash', a.deliverable]]); break
      }
    }
  }
  return [...confirmed]
}
