import { DatabaseSync } from 'node:sqlite'
import { contractsFromDeployment, foldJob, fromNodeSqlite, migrate, stmt, type IndexedEvent } from '@sidequest/indexer'
import { deployment } from '@sidequest/sdk'
import { migrateRegistry, recordOffer } from '../src/registry.ts'

/** The production fold and reader against real SQLite; synthetic chain facts never need an RPC. */
export async function activityFixture() {
  const db = new DatabaseSync(':memory:')
  const sql = fromNodeSqlite(db)
  const d = deployment('monad-testnet')
  await migrate(sql)
  await migrateRegistry(sql)
  const event = (
    jobId: string,
    name: string,
    block: number,
    logIndex = 0,
    args: IndexedEvent['args'] = {},
  ): IndexedEvent => ({
    chainId: d.chainId,
    contract: name.startsWith('Job') || name === 'PaymentReleased' ? d.core : d.stacks.main!.holding,
    jobId,
    name,
    block,
    logIndex,
    txHash: `tx-${block}`,
    args,
  })
  const published = (jobId: string, block: number, logIndex = 0): IndexedEvent =>
    event(jobId, 'Published', block, logIndex, {
      creator: d.admin,
      approver: d.admin,
      token: d.rewardTokens[0]!,
      reward: '1000',
      creatorBond: '10',
      workerBond: '20',
      policyHash: `policy-${jobId}`,
      manifestHash: `manifest-${jobId}`,
      deliveryDeadline: 100_000,
      expiredAt: 200_000,
      reviewWindow: 3600,
      disputeWindow: 3600,
      arbitrationWindow: 43_200,
    })
  const addJob = async (events: readonly IndexedEvent[], boardId: string | null = 'public') => {
    const first = events[0]!
    await sql.batch(
      events.map((e) =>
        stmt(
          'INSERT INTO events (chain_id, contract, block, log_index, tx_hash, job_id, name, args_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          e.chainId,
          e.contract,
          e.block,
          e.logIndex,
          e.txHash,
          e.jobId,
          e.name,
          JSON.stringify(e.args),
        ),
      ),
    )
    await sql.batch(foldJob(contractsFromDeployment(d), first.chainId, first.jobId!, events))
    if (boardId !== null)
      await recordOffer(sql, {
        boardId,
        termsHash: `manifest-${first.jobId}`,
        taskId: `task-${first.jobId}`,
        now: first.block,
      })
  }
  return { db, sql, deployment: d, event, published, addJob }
}
