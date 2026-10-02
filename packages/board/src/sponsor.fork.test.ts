/** Real v1 bytecode and deployed DelegationManager/enforcers on a local Monad fork; no remote broadcasts. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@agent-jobs/sdk'
import { type Hex, decodeFunctionData, encodeFunctionData, parseEther, parseTransaction } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forkEnabled, startHirelingFork } from '../../sdk/test/hireling-fixture.ts'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'
import { SPONSOR_LIMITS } from './sponsor.ts'
import { type Delegation, parseDelegation, redeemCallsCalldata } from './delegation.ts'

const caller = (wallet: sdk.Wallet) => ({ address: wallet.account.address })

const fork = forkEnabled ? describe : describe.skip
fork('sponsorship against the real Monad Delegation Framework', () => {
  let f: Awaited<ReturnType<typeof startHirelingFork>>, board: Board, db: DatabaseSync, now: number, agentId: bigint
  const boot = () => new Board(fromNodeSqlite(db), { network: 'monad-testnet', contexts: { main: { ...f.ctx, deployment: { ...f.ctx.deployment, relay: f.admin.account.address } } },
    relay: { account: f.admin.account as import('viem').LocalAccount, rpcUrl: f.url }, domain: 'fork.test', uri: 'https://fork.test', manifestBaseUrl: 'https://fork.test/offers', now: () => now })
  async function enable(wallet: sdk.Wallet) {
    const prep = await board.sponsorPrepare(caller(wallet), { wallet: wallet.account.address })
    if (prep.upgrade !== null) {
      const authorization = await wallet.signAuthorization({ account: wallet.account, contractAddress: f.ctx.deployment.delegation.delegator, executor: 'self' })
      const hash = await wallet.sendTransaction({ to: wallet.account.address, data: '0x', authorizationList: [authorization] })
      expect((await f.ctx.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success')
    }
    return board.sponsorConfirm(caller(wallet), { wallet: wallet.account.address, signature: await sdk.signTypedDataJson(wallet, prep.sign.typedData) })
  }
  const submit = (wallet: sdk.Wallet, key: string, calls: readonly sdk.TxRequest[]) => board.sponsorSubmit(caller(wallet), { wallet: wallet.account.address, key, calls })
  beforeAll(async () => {
    f = await startHirelingFork(); db = new DatabaseSync(':memory:'); now = Number((await f.ctx.publicClient.getBlock()).timestamp); board = boot()
    agentId = await sdk.registerAgent(f.ctx, f.worker, 'https://hireling.xyz/sponsor-fork')
    await sdk.stake(f.ctx, f.creator, parseEther('100')); await sdk.stake(f.ctx, f.worker, parseEther('100'))
  }, 180_000)
  afterAll(() => { db?.close(); f?.close() })

  it('activates and submits as the worker, then atomically accepts/settles as creator; retries and polling never send twice', async () => {
    expect((await enable(f.worker)).status).toBe('live')
    expect((await enable(f.creator)).status).toBe('live')
    const created = await board.createTask(caller(f.creator), { title: 'Sponsored hire', brief: 'Fork test', acceptanceCriteria: ['finished'], token: f.ctx.stack.factory,
      reward: '1', creatorBond: '10', workerBond: '10', deliveryDeadline: now + 3600, mode: 'hire',
      windows: { reviewSeconds: 3600, disputeSeconds: 3600, arbitrationSeconds: 43200 }, invite: { agentId: agentId.toString() }, deliverable: { accepts: ['onchain'] } })
    const hashes = await sdk.sendAll(f.creator, f.ctx.publicClient, created.transactions)
    const task = await board.reportTransaction(caller(f.creator), { taskId: created.taskId, txHash: hashes.at(-1)! })
    const sel = await board.selectWorker(caller(f.creator), { taskId: created.taskId, applicationId: created.applicationId! })
    await board.submitSelection(caller(f.creator), { taskId: created.taskId, nonce: sel.nonce, signature: await sdk.signTypedDataJson(f.creator, sel.sign.typedData) })
    const prep = await board.prepareActivation(caller(f.worker), { taskId: created.taskId })
    const activation = await board.buildActivation(caller(f.worker), { taskId: created.taskId, budgetSignature: await sdk.signTypedDataJson(f.worker, prep.sign.typedData) })
    const workerNonce = await f.ctx.publicClient.getTransactionCount({ address: f.worker.account.address })
    const active = await submit(f.worker, 'activate', activation.transactions)
    expect(active).toMatchObject({ status: 'confirmed', callsUsed: 1 })
    const activeReport = await board.reportTransaction(caller(f.contributor), { taskId: created.taskId, txHash: active.txHash })
    expect(activeReport.operations.find(o => o.kind === 'activate')).toMatchObject({ status: 'confirmed', tx_hash: active.txHash })
    expect(await f.ctx.publicClient.getTransactionCount({ address: f.worker.account.address })).toBe(workerNonce)
    expect((await sdk.getJob(f.ctx, BigInt(task.jobId!))).provider.toLowerCase()).toBe(f.worker.account.address.toLowerCase())
    const delivery = await board.submitWork(caller(f.worker), { taskId: created.taskId, deliverable: { kind: 'onchain', chainId: 10143, address: f.ctx.stack.holding } })
    const delivered = await submit(f.worker, 'deliver', delivery.transactions)
    expect(delivered.status).toBe('confirmed')
    const deliveredReport = await board.reportTransaction(caller(f.contributor), { taskId: created.taskId, txHash: delivered.txHash })
    expect(deliveredReport.operations.find(o => o.kind === 'submit')).toMatchObject({ status: 'confirmed', tx_hash: delivered.txHash })
    expect(deliveredReport.onchainSubmission?.deliverable_hash).toBe(delivery.deliverableHash)
    const accepted = await board.approveWork(caller(f.creator), { taskId: created.taskId })
    const settlement: sdk.TxRequest = { description: 'Settle fees', chainId: f.ctx.deployment.chainId, to: f.ctx.stack.holding, value: '0',
      data: encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'settle', args: [BigInt(task.jobId!)] }) }
    const paid = await submit(f.creator, 'accept-settle', [...accepted.transactions, settlement])
    expect(paid).toMatchObject({ status: 'confirmed', callsUsed: 2 })
    const paidReport = await board.reportTransaction(caller(f.contributor), { taskId: created.taskId, txHash: paid.txHash })
    expect(paidReport.operations.find(o => o.kind === 'accept')).toMatchObject({ status: 'confirmed', tx_hash: paid.txHash })
    const receipt = await f.ctx.publicClient.getTransactionReceipt({ hash: paid.txHash })
    const op = db.prepare('SELECT raw_tx, cost, baseline_calls FROM sponsor_operations WHERE id=?').get(paid.operationId) as { raw_tx: Hex; cost: string; baseline_calls: number }
    expect(parseTransaction(op.raw_tx).gas).toBeGreaterThanOrEqual(sdk.V1_GAS.evaluator + sdk.V1_GAS.settle + 100_000n)
    expect(BigInt(op.cost)).toBe(receipt.gasUsed * receipt.effectiveGasPrice)
    expect(op.baseline_calls).toBe(0)
    expect((await sdk.getJob(f.ctx, BigInt(task.jobId!))).statusName).toBe('Completed')
    // Simulate a response lost after mining and before recording success.
    db.prepare("UPDATE sponsor_operations SET status='pending', cost=NULL WHERE id=?").run(paid.operationId)
    board = boot()
    const relayNonce = await f.ctx.publicClient.getTransactionCount({ address: f.admin.account.address })
    expect(await submit(f.creator, 'accept-settle', [...accepted.transactions, settlement])).toEqual(paid)
    expect(await board.sponsorOperation(caller(f.creator), { wallet: f.creator.account.address, operationId: paid.operationId })).toEqual(paid)
    expect(await f.ctx.publicClient.getTransactionCount({ address: f.admin.account.address })).toBe(relayNonce)
    // A lost-answer retry remains an operation result after local revocation and current cap exhaustion.
    await board.sponsorRevoke(caller(f.creator), { wallet: f.creator.account.address })
    expect(await submit(f.creator, 'accept-settle', [...accepted.transactions, settlement])).toEqual(paid)
    await enable(f.creator)
    await expect(submit(f.creator, 'different-action', [...accepted.transactions, settlement])).rejects.toMatchObject({ reason: 'simulation' })
  }, 180_000)

  it('reports a sponsored cancel/settle batch by its canonical creator, regardless of the reporter or relay', async () => {
    const created = await board.createTask(caller(f.creator), { title: 'Cancel sponsored hire', brief: 'Fork test', acceptanceCriteria: ['finished'], token: f.ctx.stack.factory,
      reward: '1', creatorBond: '10', workerBond: '10', deliveryDeadline: now + 3600, mode: 'hire', windows: { reviewSeconds: 3600, disputeSeconds: 3600, arbitrationSeconds: 43200 } })
    const hashes = await sdk.sendAll(f.creator, f.ctx.publicClient, created.transactions)
    await board.reportTransaction(caller(f.contributor), { taskId: created.taskId, txHash: hashes.at(-1)! })
    const cancel = await board.cancelTask(caller(f.creator), { taskId: created.taskId })
    const cancelled = await submit(f.creator, 'cancel-settle', cancel.transactions)
    expect(cancelled.status).toBe('confirmed')
    const reported = await board.reportTransaction(caller(f.worker), { taskId: created.taskId, txHash: cancelled.txHash })
    expect(reported.operations.find(o => o.kind === 'cancel')).toMatchObject({ status: 'confirmed', tx_hash: cancelled.txHash })
    expect(reported.chain.status).toBe('cancelled')
  }, 120_000)

  it('the chain enforcers refuse unsafe D15 methods, an outside target, native value, and a non-relay redeemer', async () => {
    const row = db.prepare('SELECT delegation_json, signature FROM sponsor_grants WHERE wallet=?').get(f.worker.account.address.toLowerCase()) as { delegation_json: string; signature: Hex }
    const signed: Delegation = { ...parseDelegation(row.delegation_json), signature: row.signature }
    const data = encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'requestUnstake', args: [parseEther('1')] })
    await expect(f.ctx.publicClient.call({ account: f.admin.account, to: f.ctx.deployment.delegation.manager,
      data: redeemCallsCalldata(signed, [{ target: f.ctx.deployment.hireling!.vault, callData: data, value: 0n }]) })).rejects.toThrow()
    const call = { target: f.ctx.stack.holding, callData: encodeFunctionData({ abi: sdk.hirelingHoldingAbi, functionName: 'cancelSelection', args: [987n] }), value: 0n }
    for (const invalid of [{ ...call, target: f.ctx.stack.factory }, { ...call, value: 1n }]) {
      await expect(f.ctx.publicClient.call({ account: f.admin.account, to: f.ctx.deployment.delegation.manager, data: redeemCallsCalldata(signed, [invalid]) })).rejects.toThrow()
    }
    await expect(f.ctx.publicClient.call({ account: f.contributor.account, to: f.ctx.deployment.delegation.manager, data: redeemCallsCalldata(signed, [call]) })).rejects.toThrow()
    const creatorNonce = await f.ctx.publicClient.getTransactionCount({ address: f.creator.account.address })
    expect((await board.sponsorStatus(caller(f.worker), { wallet: f.worker.account.address })).callsUsed).toBe(2)
    expect(await f.ctx.publicClient.getTransactionCount({ address: f.creator.account.address })).toBe(creatorNonce)
  }, 60_000)

  it('revocation stops board sends and disables the root on-chain; expired delegations refuse', async () => {
    const revoked = await board.sponsorRevoke(caller(f.worker), { wallet: f.worker.account.address })
    expect(decodeFunctionData({ abi: (await import('./delegation.ts')).delegationManagerAbi, data: revoked.transactions[0]!.data }).functionName).toBe('disableDelegation')
    expect((await board.sponsorStatus(caller(f.worker), { wallet: f.worker.account.address })).status).toBe('revoked')
    await sdk.sendAll(f.worker, f.ctx.publicClient, revoked.transactions)
    expect((await board.sponsorStatus(caller(f.worker), { wallet: f.worker.account.address })).status).toBe('revoked')
    now += SPONSOR_LIMITS.validity
    expect((await board.sponsorStatus(caller(f.creator), { wallet: f.creator.account.address })).status).toBe('expired')
  }, 60_000)
})
