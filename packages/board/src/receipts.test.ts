import * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex, type TransactionReceipt, encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem'
import { expect, it, vi } from 'vitest'
import { confirmedOperationIds } from './receipts.ts'
import type { OperationRow } from './store.ts'

const wallet = `0x${'1'.repeat(40)}` as Address, relay = `0x${'2'.repeat(40)}` as Address, mallory = `0x${'3'.repeat(40)}` as Address
const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
const ctx = { ...base, stack: { ...base.stack, kind: 'hireling-v1' as const }, publicClient: { ...base.publicClient,
  readContract: vi.fn(async () => ({ creator: wallet, approver: wallet })) } } as unknown as sdk.Ctx
const op = (kind: string, actor: string = wallet, detail?: object): OperationRow => ({ id: kind + actor, kind, actor, task_id: 'task', status: 'prepared', tx_hash: null, detail: detail === undefined ? null : JSON.stringify(detail), created_at: 0, updated_at: 0 })
const receipt = (logs: unknown[]): TransactionReceipt => ({ status: 'success', from: relay, to: ctx.deployment.delegation.manager, logs }) as TransactionReceipt
function accepted(approver: Address = wallet, address = ctx.stack.evaluator, jobId = 1n) {
  return { address, data: '0x' as Hex, topics: encodeEventTopics({ abi: sdk.hirelingEvaluatorAbi, eventName: 'Accepted', args: { jobId, approver } }) }
}

it('a relay/manager receipt confirms only the decoded event actor and method', async () => {
  const ops = [op('accept'), op('accept', mallory), op('reject'), op('submit')]
  expect(await confirmedOperationIds(ctx, 1n, receipt([accepted()]), ops)).toEqual([op('accept').id])
  expect(await confirmedOperationIds(ctx, 1n, receipt([accepted(mallory)]), ops)).toEqual([op('accept', mallory).id])
})
it('counterfeit contracts, another job, and reverted receipts cannot confirm an operation', async () => {
  for (const r of [receipt([accepted(wallet, mallory)]), receipt([accepted(wallet, ctx.stack.evaluator, 2n)]), { ...receipt([accepted()]), status: 'reverted' as const }])
    expect(await confirmedOperationIds(ctx, 1n, r, [op('accept')])).toEqual([])
})
it('an activation event must match the prepared selection nonce', async () => {
  const log = { address: ctx.stack.holding, topics: encodeEventTopics({ abi: sdk.hirelingHoldingAbi, eventName: 'Activated', args: { jobId: 1n, worker: wallet } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint16' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [4n, 5n, 3000, 3n, 7n, 1n]) }
  expect(await confirmedOperationIds(ctx, 1n, receipt([log]), [op('activate', wallet, { selectionNonce: '5' })])).toEqual([op('activate').id])
  expect(await confirmedOperationIds(ctx, 1n, receipt([log]), [op('activate', wallet, { selectionNonce: '6' })])).toEqual([])
})
it('the core submission event confirms only the recorded deliverable, regardless of reporter/sender', async () => {
  const deliverable = sdk.hashText('delivery')
  const log = { address: ctx.deployment.core, topics: encodeEventTopics({ abi: sdk.coreAbi, eventName: 'JobSubmitted', args: { jobId: 1n, provider: wallet } }), data: encodeAbiParameters([{ type: 'bytes32' }], [deliverable]) }
  expect(await confirmedOperationIds(ctx, 1n, receipt([log]), [op('submit', wallet, { deliverableHash: deliverable })])).toEqual([op('submit').id])
  expect(await confirmedOperationIds(ctx, 1n, receipt([log]), [op('submit', wallet, { deliverableHash: sdk.hashText('different') })])).toEqual([])
})
it('cancel is authorized by the canonical listing creator, and a settle event never confirms an accept', async () => {
  const abi = parseAbi(['event Cancelled(uint256 indexed jobId)'])
  expect(await confirmedOperationIds(ctx, 1n, receipt([{ address: ctx.stack.holding, data: '0x', topics: encodeEventTopics({ abi, eventName: 'Cancelled', args: { jobId: 1n } }) }]), [op('cancel'), op('cancel', mallory)])).toEqual([op('cancel').id])
  const settle = { address: ctx.stack.holding, topics: encodeEventTopics({ abi: sdk.hirelingHoldingAbi, eventName: 'RewardSettled', args: { jobId: 1n, to: wallet } }), data: encodeAbiParameters([{ type: 'uint8' }, { type: 'uint256' }], [1, 7n]) }
  expect(await confirmedOperationIds(ctx, 1n, receipt([settle]), [op('accept')])).toEqual([])
})
