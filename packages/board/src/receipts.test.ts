import * as sdk from '@agent-jobs/sdk'
import { type Address, type Hex, type TransactionReceipt, encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem'
import { expect, it, vi } from 'vitest'
import { confirmedOperationIds, confirmsVaultOperation, vaultOperationResult } from './receipts.ts'
import { DatabaseSync } from 'node:sqlite'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'
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
  for (const detail of [undefined, {}, { selectionNonce: null }]) expect(await confirmedOperationIds(ctx, 1n, receipt([log]), [op('activate', wallet, detail)])).toEqual([])
})
it('same-reason rejections confirm only their exact violation, with complete prepared details', async () => {
  const reasonHash = sdk.hashText('same reason')
  const log = { address: ctx.stack.evaluator, topics: encodeEventTopics({ abi: sdk.hirelingEvaluatorAbi, eventName: 'Rejected', args: { jobId: 1n, approver: wallet } }),
    data: encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes32' }], [1, reasonHash]) }
  const none = { ...op('reject', wallet, { reasonHash, violation: 'None' }), id: 'none' }, quality = { ...op('reject', wallet, { reasonHash, violation: 'Quality' }), id: 'quality' }
  expect(await confirmedOperationIds(ctx, 1n, receipt([log]), [none, quality, op('reject', wallet, { reasonHash }), op('reject', mallory, { reasonHash, violation: 'Quality' })])).toEqual(['quality'])
})
it('rulings match both decision flags and the canonical v1 or legacy arbitrator', async () => {
  const reasonHash = sdk.hashText('decision')
  const fields = encodeAbiParameters([{ type: 'bool' }, { type: 'bool' }, { type: 'bytes32' }], [true, false, reasonHash])
  const log = { address: ctx.stack.evaluator, topics: encodeEventTopics({ abi: sdk.hirelingEvaluatorAbi, eventName: 'Ruled', args: { jobId: 1n, arbitrator: wallet } }), data: fields }
  const right = op('rule', wallet, { reasonHash, forWorker: true, slashLoser: false })
  const wrong = [op('rule', wallet, { reasonHash, forWorker: false, slashLoser: false }), op('rule', wallet, { reasonHash, forWorker: true, slashLoser: true }), op('rule', wallet, { reasonHash }), op('rule', mallory, { reasonHash, forWorker: true, slashLoser: false })]
  expect(await confirmedOperationIds(ctx, 1n, receipt([log]), [right, ...wrong])).toEqual([right.id])
  const legacy = { ...ctx, stack: { ...ctx.stack, kind: 'legacy' as const }, publicClient: { ...ctx.publicClient, readContract: vi.fn(async () => wallet) } } as unknown as sdk.Ctx
  const old = { ...log, topics: encodeEventTopics({ abi: sdk.jobsEvaluatorAbi, eventName: 'Ruled', args: { jobId: 1n } }) }
  expect(await confirmedOperationIds(legacy, 1n, receipt([old]), [right, ...wrong])).toEqual([right.id])
})
it('a legacy award confirms its exact worker, agent and deliverable, leaving other candidates prepared', async () => {
  const legacy = { ...ctx, stack: { ...ctx.stack, kind: 'legacy' as const } }
  const deliverableHash = sdk.hashText('candidate B')
  const log = { address: ctx.stack.holding, topics: encodeEventTopics({ abi: sdk.jobHoldingAbi, eventName: 'Awarded', args: { jobId: 1n, worker: mallory } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [2n, deliverableHash]) }
  const b = { ...op('award', wallet, { candidateId: 'B', worker: mallory, agentId: '2', deliverableHash }), id: 'B' }
  const a = { ...op('award', wallet, { candidateId: 'A', worker: wallet, agentId: '1', deliverableHash: sdk.hashText('candidate A') }), id: 'A' }
  expect(await confirmedOperationIds(legacy, 1n, receipt([log]), [a, b, op('award', wallet, { candidateId: 'old' })])).toEqual(['B'])
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

const vault = `0x${'4'.repeat(40)}` as Address
const vaultCtx = { ...ctx, deployment: { ...ctx.deployment, hireling: { vault, factory: ctx.stack.factory } } } as sdk.Ctx
function vaultLog(kind: 'stake' | 'request-unstake' | 'cancel-unstake' | 'withdraw-stake', account = wallet, payer = wallet, amount = 7n, address = vault, shares = 7n, delegator = wallet) {
  if (kind === 'stake') return { address, topics: encodeEventTopics({ abi: sdk.stakeVaultAbi, eventName: 'Delegated', args: { account, delegator, payer } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [amount, shares]) }
  if (kind === 'request-unstake') return { address, topics: encodeEventTopics({ abi: sdk.stakeVaultAbi, eventName: 'UndelegateRequested', args: { account, delegator } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint48' }], [shares, amount, 10n, 1000]) }
  if (kind === 'cancel-unstake') return { address, topics: encodeEventTopics({ abi: sdk.stakeVaultAbi, eventName: 'UndelegateCancelled', args: { account, delegator } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [shares, amount]) }
  return { address, topics: encodeEventTopics({ abi: sdk.stakeVaultAbi, eventName: 'Withdrawn', args: { account, delegator } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [shares, amount]) }
}
const vaultOp = (kind: string) => op(kind, wallet, { vault, token: ctx.stack.factory, account: wallet, delegator: wallet, payer: wallet, amount: '7', shares: '7' })
it.each(['stake', 'request-unstake', 'cancel-unstake', 'withdraw-stake'] as const)('vault %s matches ownership, method and configured vault despite floating asset quotes', kind => {
  const prepared = vaultOp(kind)
  expect(confirmsVaultOperation(vaultCtx, receipt([vaultLog(kind)]), prepared)).toBe(true)
  for (const log of [vaultLog(kind, mallory), vaultLog(kind, wallet, wallet, 7n, vault, 7n, mallory), vaultLog(kind, wallet, wallet, 7n, mallory), accepted()])
    expect(confirmsVaultOperation(vaultCtx, receipt([log]), prepared)).toBe(false)
  const changedAssets = vaultOperationResult(vaultCtx, receipt([vaultLog(kind, wallet, wallet, 1n)]), prepared)
  if (kind === 'stake') expect(changedAssets).toBeNull()
  else expect(changedAssets).toMatchObject({ shares: '7', assets: '1' })
  expect(confirmsVaultOperation(vaultCtx, receipt([vaultLog(kind, wallet, wallet, 7n, vault, 8n)]), prepared)).toBe(kind === 'stake')
  expect(confirmsVaultOperation(vaultCtx, { ...receipt([vaultLog(kind)]), status: 'reverted' }, prepared)).toBe(false)
  expect(confirmsVaultOperation(vaultCtx, receipt([vaultLog(kind)]), { ...prepared, detail: null })).toBe(false)
})
it('third-party delegateFor cannot confirm a wallet stake, and a replaced vault cannot confirm an old preparation', () => {
  expect(confirmsVaultOperation(vaultCtx, receipt([vaultLog('stake', wallet, mallory)]), vaultOp('stake'))).toBe(false)
  expect(confirmsVaultOperation({ ...vaultCtx, deployment: { ...vaultCtx.deployment, hireling: { ...vaultCtx.deployment.hireling!, vault: mallory } } }, receipt([vaultLog('stake')]), vaultOp('stake'))).toBe(false)
})
it('a saved wallet-operation hash survives a lost receipt response and polls the original without another preparation', async () => {
  const db = new DatabaseSync(':memory:'), sql = fromNodeSqlite(db)
  const hash = sdk.hashText('vault receipt')
  const getTransactionReceipt = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValue(receipt([vaultLog('stake')]))
  const config = { network: 'monad-testnet' as const, contexts: { main: { ...vaultCtx, publicClient: { ...vaultCtx.publicClient, getTransactionReceipt } } as sdk.Ctx }, domain: 'test', uri: 'https://test', manifestBaseUrl: '' }
  try {
    const board = new Board(sql, config), original = vaultOp('stake')
    sql.run('INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?)', original.id, 'vault:' + wallet, original.kind, original.actor, original.status, null, original.detail, 0, 0)
    await expect(board.reportOperation({ address: wallet }, { operationId: original.id, txHash: hash })).rejects.toThrow('no receipt')
    expect(sql.all('SELECT status,tx_hash FROM operations')[0]).toEqual({ status: 'prepared', tx_hash: hash })
    const restarted = new Board(sql, config)
    expect(await restarted.reportOperation({ address: wallet }, { operationId: original.id })).toMatchObject({ operationId: original.id, kind: 'stake', status: 'confirmed', txHash: hash, result: { shares: '7', assets: '7' } })
    expect(JSON.parse(sql.all<OperationRow>('SELECT * FROM operations')[0]!.detail!).result).toMatchObject({ assets: '7', shares: '7' })
    expect(sql.all('SELECT * FROM operations')).toHaveLength(1)
    expect(await restarted.reportOperation({ address: wallet }, { operationId: original.id, txHash: sdk.hashText('different') })).toMatchObject({ txHash: hash, status: 'confirmed' })
    await expect(restarted.reportOperation({ address: mallory }, { operationId: original.id })).rejects.toThrow('no wallet operation')
    expect(getTransactionReceipt).toHaveBeenCalledTimes(2)
  } finally { db.close() }
})

it('VV2-002 confirms the A=6/S=10 request by its three exact shares, not its two-asset quote', () => {
  const operation = op('request-unstake', wallet, { vault, token: ctx.stack.factory, account: mallory,
    delegator: wallet, amount: '2', shares: '3' })
  expect(vaultOperationResult(vaultCtx, receipt([vaultLog('request-unstake', mallory, wallet, 1n, vault, 3n)]), operation))
    .toMatchObject({ account: mallory, delegator: wallet, shares: '3', assets: '1' })
  expect(vaultOperationResult(vaultCtx, receipt([vaultLog('request-unstake', mallory, wallet, 1n, vault, 2n)]), operation)).toBeNull()
})
