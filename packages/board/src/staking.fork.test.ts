import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { formatUnits } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forkEnabled, forkSetupTimeout, startSidequestFork } from '../../sdk/test/sidequest-fixture.ts'
import { Board } from './service.ts'
import { fromNodeSqlite, type OperationRow } from './store.ts'

const fork = forkEnabled ? describe : describe.skip
fork('vault operation receipts against real delegated vault bytecode', () => {
  let f: Awaited<ReturnType<typeof startSidequestFork>>
  let agentId: bigint
  let creatorBond: bigint
  let seq = 0
  beforeAll(async () => {
    f = await startSidequestFork()
    creatorBond = (await sdk.readBondPolicy(f.ctx)).minimumCreatorBond
    agentId = await sdk.registerAgent(f.ctx, f.worker, 'https://sidequest.exchange/receipt-regression')
    await sdk.delegate(f.ctx, f.creator, creatorBond * 2n)
    await sdk.delegate(f.ctx, f.creator, 10n, f.worker.account.address)
  }, forkSetupTimeout())
  afterAll(() => f?.close())

  async function slash(amount: bigint) {
    const now = Number((await f.ctx.publicClient.getBlock()).timestamp)
    const terms = {
      creator: f.creator.account.address,
      approver: f.creator.account.address,
      token: f.ctx.stack.factory,
      reward: 101n,
      creatorBond,
      workerBond: amount,
      arbitrator: f.arbitrator.account.address,
      reviewWindow: 3600,
      disputeWindow: 3600,
      arbitrationWindow: 43200,
      deliveryDeadline: now + 120,
    }
    const termsHash = sdk.hashText(`receipt-${seq++}`)
    const { jobId } = await sdk.publish(f.ctx, f.creator, { ...terms, manifestHash: termsHash, termsHash })
    const selection = {
      jobId,
      worker: f.worker.account.address,
      agentId,
      termsHash,
      activateBy: now + 100,
      nonce: BigInt(seq),
    }
    await sdk.activate(f.ctx, f.worker, selection, await sdk.signSelection(f.ctx, f.creator, selection), terms)
    await f.rpc('evm_setNextBlockTimestamp', [now + 121])
    await f.rpc('evm_mine')
    await sdk.burnMissedDelivery(f.ctx, f.contributor, jobId)
    await sdk.settle(f.ctx, f.contributor, jobId)
  }

  function board(db: DatabaseSync) {
    const sql = fromNodeSqlite(db)
    return {
      sql,
      board: new Board(sql, {
        network: 'monad-testnet',
        contexts: { main: f.ctx },
        domain: 'test',
        uri: 'https://test',
        manifestBaseUrl: '',
      }),
    }
  }

  it('VV2-002 confirms the rounded outside-owner exit and persists actual assets', async () => {
    await slash(4n)
    const db = new DatabaseSync(':memory:')
    try {
      const { board: b, sql } = board(db)
      const caller = { address: f.creator.account.address }
      const prepared = await b.requestUnstake(caller, {
        amount: formatUnits(2n, 18),
        account: f.worker.account.address,
      })
      expect(prepared.shares).toBe('3')
      const [hash] = await sdk.sendAll(f.creator, f.ctx.publicClient, prepared.transactions)
      expect(await b.reportOperation(caller, { operationId: prepared.operationId, txHash: hash! })).toMatchObject({
        status: 'confirmed',
        result: { account: f.worker.account.address, delegator: f.creator.account.address, shares: '3', assets: '1' },
      })
      const row = sql.all<OperationRow>('SELECT * FROM operations WHERE id=?', prepared.operationId)[0]!
      expect(row.task_id).toBe(
        `vault:${f.worker.account.address.toLowerCase()}:${f.creator.account.address.toLowerCase()}`,
      )
      expect(JSON.parse(row.detail!).amount).toBe('2')
      expect(JSON.parse(row.detail!).result.assets).toBe('1')
      const cancelled = await b.cancelUnstake(caller, { account: f.worker.account.address })
      const [cancelHash] = await sdk.sendAll(f.creator, f.ctx.publicClient, cancelled.transactions)
      expect(
        await b.reportOperation(caller, { operationId: cancelled.operationId, txHash: cancelHash! }),
      ).toMatchObject({ status: 'confirmed', result: { shares: '3' } })
    } finally {
      db.close()
    }
  }, 120_000)

  it('confirms the original deposit when a pending slash changes its minted shares', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      const { board: b } = board(db)
      const caller = { address: f.creator.account.address }
      const prepared = await b.stake(caller, { amount: formatUnits(2n, 18), account: f.worker.account.address })
      expect(prepared.shares).toBe('3')
      await slash(1n)
      const [hash] = await sdk.sendAll(f.creator, f.ctx.publicClient, prepared.transactions)
      expect(await b.reportOperation(caller, { operationId: prepared.operationId, txHash: hash! })).toMatchObject({
        status: 'confirmed',
        result: { payer: f.creator.account.address, delegator: f.creator.account.address, shares: '4', assets: '2' },
      })
    } finally {
      db.close()
    }
  }, 120_000)
})
