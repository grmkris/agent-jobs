/** Real v1 bytecode and deployed DelegationManager/enforcers on a local Monad fork; no remote broadcasts. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { type Hex, decodeFunctionData, encodeFunctionData, parseEther, parseTransaction } from 'viem'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { forkEnabled, forkSetupTimeout, startSidequestFork } from '../../sdk/test/sidequest-fixture.ts'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'
import { SPONSOR_LIMITS } from './sponsor.ts'
import { type Delegation, parseDelegation, redeemCallsCalldata } from '@sidequest/sdk'

const caller = (wallet: sdk.Wallet) => ({ address: wallet.account.address })

const fork = forkEnabled ? describe : describe.skip
fork('sponsorship against the real Monad Delegation Framework', () => {
  let f: Awaited<ReturnType<typeof startSidequestFork>>, board: Board, db: DatabaseSync, now: number, agentId: bigint
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
  const submit = async (wallet: sdk.Wallet, key: string, calls: readonly sdk.TxRequest[]) => {
    const status = await board.sponsorStatus(caller(wallet), { wallet: wallet.account.address })
    return board.sponsorSubmit(caller(wallet), { wallet: wallet.account.address, key, entries: status.delegationHash === null ? [] : [{ grant: status.delegationHash, calls }] })
  }
  beforeAll(async () => {
    f = await startSidequestFork(); db = new DatabaseSync(':memory:'); now = Number((await f.ctx.publicClient.getBlock()).timestamp); board = boot()
    agentId = await sdk.registerAgent(f.ctx, f.worker, 'https://sidequest.exchange/sponsor-fork')
    await sdk.delegate(f.ctx, f.creator, parseEther('100')); await sdk.delegate(f.ctx, f.worker, parseEther('100'))
  }, forkSetupTimeout())
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
    expect(db.prepare("SELECT status FROM operations WHERE task_id=? AND kind='activate'").get(created.taskId)).toEqual({ status: 'prepared' })
    expect((await f.ctx.publicClient.getTransactionReceipt({ hash: active.txHash })).from.toLowerCase()).toBe(f.admin.account.address.toLowerCase())
    board = boot()
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
      data: encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'settle', args: [BigInt(task.jobId!)] }) }
    const paid = await submit(f.creator, 'accept-settle', [...accepted.transactions, settlement])
    expect(paid).toMatchObject({ status: 'confirmed', callsUsed: 2 })
    expect(db.prepare("SELECT status FROM operations WHERE task_id=? AND kind='accept'").get(created.taskId)).toEqual({ status: 'prepared' })
    board = boot()
    const paidReport = await board.reportTransaction(caller(f.contributor), { taskId: created.taskId, txHash: paid.txHash })
    expect(paidReport.operations.find(o => o.kind === 'accept')).toMatchObject({ status: 'confirmed', tx_hash: paid.txHash })
    expect(paidReport.operations.filter(o => o.status === 'prepared')).toEqual([])
    expect((await sdk.getV1Listing(f.ctx, BigInt(task.jobId!))).outcome).toBe(1)
    expect(await board.sponsorOperation(caller(f.creator), { wallet: f.creator.account.address, operationId: paid.operationId })).toEqual(paid)
    expect(await board.reportTransaction(caller(f.worker), { taskId: created.taskId, txHash: paid.txHash })).toMatchObject({ operations: paidReport.operations })
    const receipt = await f.ctx.publicClient.getTransactionReceipt({ hash: paid.txHash })
    const op = db.prepare('SELECT raw_tx, cost, baseline_calls FROM sponsor_operations WHERE id=?').get(paid.operationId) as { raw_tx: Hex; cost: string; baseline_calls: number }
    const signed = parseTransaction(op.raw_tx)
    expect(signed.gas).toBeGreaterThanOrEqual(receipt.gasUsed)
    expect(signed.maxPriorityFeePerGas).toBeLessThan(signed.maxFeePerGas!)
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

  it('coordinates a relayed EIP-7702 upgrade and a sponsored action without colliding nonces', async () => {
    const nonce = await f.ctx.publicClient.getTransactionCount({ address: f.admin.account.address })
    const authorization = await f.contributor.signAuthorization({ account: f.contributor.account, contractAddress: f.ctx.deployment.delegation.delegator, executor: f.admin.account.address })
    const calls: sdk.TxRequest[] = [{ description: 'Invalidate an unused selection', chainId: 10143, to: f.ctx.stack.holding, value: '0',
      data: encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'cancelSelection', args: [987654n] }) }]
    const [upgrade, sponsored] = await Promise.all([
      board.upgradeAccount(caller(f.contributor), { authorization: { ...authorization } }), submit(f.worker, 'concurrent-upgrade', calls),
    ])
    expect(upgrade.upgraded).toBe(true); expect(sponsored.status).toBe('confirmed')
    const rows = db.prepare('SELECT nonce,raw_tx FROM relay_operations').all() as { nonce: number; raw_tx: Hex }[]
    const op = db.prepare('SELECT nonce FROM sponsor_operations WHERE id=?').get(sponsored.operationId) as { nonce: number }
    expect(rows.some(r => r.nonce === nonce || r.nonce === nonce + 1)).toBe(true)
    expect(rows.every(r => r.nonce !== op.nonce)).toBe(true)
    expect(await f.ctx.publicClient.getTransactionCount({ address: f.admin.account.address })).toBe(nonce + 2)
    const raw = rows.at(-1)!.raw_tx
    expect(parseTransaction(raw).type).toBe('eip7702')
  }, 120_000)

  it('the chain enforcers refuse unsafe D15 methods, an outside target, native value, and a non-relay redeemer', async () => {
    const row = db.prepare("SELECT delegation_json, signature FROM grants WHERE delegator=? AND kind='operator'").get(f.worker.account.address.toLowerCase()) as { delegation_json: string; signature: Hex }
    const signed: Delegation = { ...parseDelegation(row.delegation_json), signature: row.signature }
    const data = encodeFunctionData({ abi: sdk.stakeVaultAbi, functionName: 'requestUndelegate', args: [f.creator.account.address, parseEther('1')] })
    await expect(f.ctx.publicClient.call({ account: f.admin.account, to: f.ctx.deployment.delegation.manager,
      data: redeemCallsCalldata(signed, [{ target: f.ctx.deployment.sidequest!.vault, callData: data, value: 0n }]) })).rejects.toThrow()
    const call = { target: f.ctx.stack.holding, callData: encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'cancelSelection', args: [987n] }), value: 0n }
    for (const invalid of [{ ...call, target: f.ctx.stack.factory }, { ...call, value: 1n }]) {
      await expect(f.ctx.publicClient.call({ account: f.admin.account, to: f.ctx.deployment.delegation.manager, data: redeemCallsCalldata(signed, [invalid]) })).rejects.toThrow()
    }
    await expect(f.ctx.publicClient.call({ account: f.contributor.account, to: f.ctx.deployment.delegation.manager, data: redeemCallsCalldata(signed, [call]) })).rejects.toThrow()
    const creatorNonce = await f.ctx.publicClient.getTransactionCount({ address: f.creator.account.address })
    expect((await board.sponsorStatus(caller(f.worker), { wallet: f.worker.account.address })).callsUsed).toBe(3)
    expect(await f.ctx.publicClient.getTransactionCount({ address: f.creator.account.address })).toBe(creatorNonce)
  }, 60_000)

  it('revocation stops board sends and disables the root on-chain; expired delegations refuse', async () => {
    const revoked = await board.sponsorRevoke(caller(f.worker), { wallet: f.worker.account.address })
    expect(decodeFunctionData({ abi: (await import('@sidequest/sdk')).delegationManagerAbi, data: revoked.transactions[0]!.data }).functionName).toBe('disableDelegation')
    expect((await board.sponsorStatus(caller(f.worker), { wallet: f.worker.account.address })).status).toBe('revoked')
    await sdk.sendAll(f.worker, f.ctx.publicClient, revoked.transactions)
    expect((await board.sponsorStatus(caller(f.worker), { wallet: f.worker.account.address })).status).toBe('revoked')
    now += SPONSOR_LIMITS.validity
    expect((await board.sponsorStatus(caller(f.creator), { wallet: f.creator.account.address })).status).toBe('expired')
  }, 60_000)

  it.each(['live', 'revoked', 'expired', 'original-wins'])('recovers a persisted sponsorship crash (%s) before another relay send on real bytecode', async state => {
    await enable(f.contributor)
    const calls: sdk.TxRequest[] = [{ description: 'Invalidate an unused selection', chainId: 10143, to: f.ctx.stack.holding, value: '0',
      data: encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'cancelSelection', args: [888888n + BigInt(['live', 'revoked', 'expired', 'original-wins'].indexOf(state))] }) }]
    const nonce = await f.ctx.publicClient.getTransactionCount({ address: f.admin.account.address })
    const failedSend = vi.spyOn(f.ctx.publicClient, 'sendRawTransaction').mockRejectedValueOnce(new Error('process stopped after insert'))
    const failedWait = vi.spyOn(f.ctx.publicClient, 'waitForTransactionReceipt').mockRejectedValueOnce(new Error('not broadcast'))
    const saved = await submit(f.contributor, `recovery-${state}`, calls)
    expect(saved.status).toBe('pending')
    failedSend.mockRestore(); failedWait.mockRestore()
    const row = db.prepare('SELECT raw_tx FROM sponsor_operations WHERE id=?').get(saved.operationId) as { raw_tx: Hex }
    if (state === 'revoked' || state === 'original-wins') await board.sponsorRevoke(caller(f.contributor), { wallet: f.contributor.account.address })
    if (state === 'expired') now += SPONSOR_LIMITS.validity
    board = boot()
    const send = f.ctx.publicClient.sendRawTransaction.bind(f.ctx.publicClient)
    const sent: Hex[] = []
    const broadcasts = vi.spyOn(f.ctx.publicClient, 'sendRawTransaction').mockImplementation(async args => {
      sent.push(args.serializedTransaction)
      const tx = parseTransaction(args.serializedTransaction)
      if (tx.nonce === nonce && state !== 'live') {
        expect(db.prepare('SELECT raw_tx FROM sponsor_replacements WHERE operation_id=?').get(saved.operationId)).toEqual({ raw_tx: args.serializedTransaction })
        expect(tx.to?.toLowerCase()).toBe(f.admin.account.address.toLowerCase())
        expect(tx.value ?? 0n).toBe(0n)
        if (state === 'original-wins') {
          const hash = await send({ serializedTransaction: row.raw_tx })
          await f.ctx.publicClient.waitForTransactionReceipt({ hash })
        }
      }
      return send(args)
    })
    try {
      await board.relayTransaction({ key: `after-${state}`, to: f.admin.account.address, data: '0x' })
      const recovered = await board.sponsorOperation(caller(f.contributor), { wallet: f.contributor.account.address, operationId: saved.operationId })
      expect(recovered.status).toBe(state === 'live' || state === 'original-wins' ? 'confirmed' : 'dropped')
      expect(sent.filter(raw => raw === row.raw_tx)).toHaveLength(state === 'live' ? 1 : 0)
      expect(await f.ctx.publicClient.getTransactionCount({ address: f.admin.account.address })).toBe(nonce + 2)
      if (state === 'revoked' || state === 'expired') {
        const replacement = db.prepare('SELECT tx_hash,cost FROM sponsor_replacements WHERE operation_id=?').get(saved.operationId) as { tx_hash: Hex; cost: string }
        const receipt = await f.ctx.publicClient.getTransactionReceipt({ hash: replacement.tx_hash })
        expect(BigInt(replacement.cost)).toBe(receipt.gasUsed * receipt.effectiveGasPrice)
      }
    } finally {
      broadcasts.mockRestore()
      if (state === 'live') {
        const revoked = await board.sponsorRevoke(caller(f.contributor), { wallet: f.contributor.account.address })
        if (revoked.transactions.length > 0) await sdk.sendAll(f.contributor, f.ctx.publicClient, revoked.transactions)
      }
    }
  }, 120_000)
})
