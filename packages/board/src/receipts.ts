/** Operation reconciliation uses verified contract events, including calls relayed through a DeleGator. */
import * as sdk from '@sidequest/sdk'
import { type Abi, type TransactionReceipt, decodeEventLog, isAddress } from 'viem'
import { evaluatorAbi, holdingAbi } from './sidequest.ts'
import type { OperationRow } from './store.ts'

const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

function availableLogs(receipt: TransactionReceipt, consumed: ReadonlySet<number>) {
  return receipt.logs.filter(
    (log) => Number.isSafeInteger(log.logIndex) && log.logIndex >= 0 && !consumed.has(log.logIndex),
  )
}

export interface VaultOperationResult {
  account: string
  delegator: string
  payer?: string
  shares: string
  assets: string
}

export interface OperationEvent {
  operationId: string
  logIndex: number
}
export interface VaultOperationEvent {
  logIndex: number
  result: VaultOperationResult
}

/** Match fixed ownership, deposit assets and exit shares. The event supplies exit assets and minted shares. */
export function vaultOperationResult(
  ctx: sdk.Ctx,
  receipt: TransactionReceipt,
  op: OperationRow,
): VaultOperationResult | null {
  return vaultOperationEvent(ctx, receipt, op)?.result ?? null
}

export function vaultOperationEvent(
  ctx: sdk.Ctx,
  receipt: TransactionReceipt,
  op: OperationRow,
  consumed: ReadonlySet<number> = new Set(),
): VaultOperationEvent | null {
  if (receipt.status !== 'success' || ctx.deployment.sidequest === null || op.detail === null) return null
  const detail = JSON.parse(op.detail) as {
    vault?: string
    token?: string
    account?: string
    delegator?: string
    payer?: string
    shares?: string
    amount?: string
  }
  if (
    !same(detail.vault, ctx.deployment.sidequest.vault) ||
    !same(detail.token, ctx.deployment.sidequest.factory) ||
    !isAddress(detail.account ?? '') ||
    !same(detail.delegator, op.actor)
  )
    return null
  if (
    op.kind === 'stake'
      ? !same(detail.payer, op.actor) || !/^[1-9]\d*$/.test(detail.amount ?? '')
      : !/^[1-9]\d*$/.test(detail.shares ?? '')
  )
    return null
  for (const log of availableLogs(receipt, consumed)) {
    const logIndex = log.logIndex
    if (!same(log.address, detail.vault!)) continue
    try {
      const e = decodeEventLog({ abi: sdk.stakeVaultAbi, data: log.data, topics: log.topics, strict: true })
      if (!['Delegated', 'UndelegateRequested', 'UndelegateCancelled', 'Withdrawn'].includes(e.eventName)) continue
      const args = e.args as { account: string; delegator: string; payer?: string; shares: bigint; assets: bigint }
      if (!same(args.account, detail.account!) || !same(args.delegator, detail.delegator!)) continue
      const expected =
        op.kind === 'stake'
          ? 'Delegated'
          : op.kind === 'request-unstake'
            ? 'UndelegateRequested'
            : op.kind === 'cancel-unstake'
              ? 'UndelegateCancelled'
              : op.kind === 'withdraw-stake'
                ? 'Withdrawn'
                : null
      if (e.eventName !== expected) continue
      if (
        op.kind === 'stake'
          ? !same(args.payer, detail.payer!) || args.assets.toString() !== detail.amount
          : args.shares.toString() !== detail.shares
      )
        continue
      return {
        logIndex,
        result: {
          account: args.account,
          delegator: args.delegator,
          ...(args.payer === undefined ? {} : { payer: args.payer }),
          shares: args.shares.toString(),
          assets: args.assets.toString(),
        },
      }
    } catch {
      /* An unrelated or malformed log cannot confirm this operation. */
    }
  }
  return null
}

export function confirmsVaultOperation(ctx: sdk.Ctx, receipt: TransactionReceipt, op: OperationRow): boolean {
  return vaultOperationResult(ctx, receipt, op) !== null
}

export async function confirmedOperationIds(
  ctx: sdk.Ctx,
  jobId: bigint,
  receipt: TransactionReceipt,
  operations: readonly OperationRow[],
): Promise<string[]> {
  return (await confirmedOperationEvents(ctx, jobId, receipt, operations)).map((event) => event.operationId)
}

function markOperation(
  operations: readonly OperationRow[],
  confirmed: Map<string, number>,
  event: {
    logIndex: number
    kind: string
    actor: unknown
    details: Array<[string, unknown]>
  },
): void {
  const { logIndex, kind, actor, details } = event
  for (const op of operations) {
    if (confirmed.has(op.id) || op.kind !== kind || !same(actor, op.actor)) continue
    const prepared = op.detail === null ? {} : (JSON.parse(op.detail) as Record<string, unknown>)
    if (
      details.some(([key, value]) => {
        const expected =
          key === 'violation' && typeof prepared[key] === 'string'
            ? sdk.Violation[prepared[key] as sdk.ViolationName]
            : prepared[key]
        return (
          expected === undefined || expected === null || String(expected).toLowerCase() !== String(value).toLowerCase()
        )
      })
    )
      continue
    confirmed.set(op.id, logIndex)
    break
  }
}

export async function confirmedOperationEvents(
  ctx: sdk.Ctx,
  jobId: bigint,
  receipt: TransactionReceipt,
  operations: readonly OperationRow[],
  consumed: ReadonlySet<number> = new Set(),
): Promise<OperationEvent[]> {
  if (receipt.status !== 'success') return []
  const confirmed = new Map<string, number>()
  let listing: Awaited<ReturnType<typeof sdk.getListing>> | undefined
  const mark = (logIndex: number, kind: string, actor: unknown, details: Array<[string, unknown]> = []) =>
    markOperation(operations, confirmed, { logIndex, kind, actor, details })
  for (const log of availableLogs(receipt, consumed)) {
    const logIndex = log.logIndex
    let abi: Abi
    if (same(log.address, ctx.stack.holding)) abi = holdingAbi(ctx)
    else if (same(log.address, ctx.stack.evaluator)) abi = evaluatorAbi(ctx)
    else if (same(log.address, ctx.deployment.core)) abi = sdk.coreAbi
    else continue
    let event: { eventName: string; args?: Record<string, unknown> }
    try {
      event = decodeEventLog({ abi, data: log.data, topics: log.topics }) as unknown as typeof event
    } catch {
      continue
    }
    const a = event.args ?? {}
    if (a.jobId !== jobId) continue
    switch (event.eventName) {
      case 'Activated':
        mark(logIndex, 'activate', a.worker, [['selectionNonce', a.selectionNonce]])
        break
      case 'ToppedUp':
        mark(logIndex, 'top-up', a.contributor, [['amount', a.amount]])
        break
      case 'JobSubmitted':
        mark(logIndex, 'submit', a.provider, [['deliverableHash', a.deliverable]])
        break
      case 'Accepted':
        mark(logIndex, 'accept', a.approver)
        break
      case 'Rejected':
        mark(logIndex, 'reject', a.approver, [
          ['reasonHash', a.reasonHash],
          ['violation', a.violation],
        ])
        break
      case 'Disputed':
        mark(logIndex, 'dispute', a.worker)
        break
      case 'Ruled': {
        const actor = a.arbitrator
        mark(logIndex, 'rule', actor, [
          ['reasonHash', a.reasonHash],
          ['forWorker', a.forWorker],
          ['slashLoser', a.slashLoser],
        ])
        break
      }
      case 'Cancelled': {
        listing ??= await sdk.getListing(ctx, jobId)
        mark(logIndex, 'cancel', listing.creator)
        break
      }
    }
  }
  return [...confirmed].map(([operationId, logIndex]) => ({ operationId, logIndex }))
}
