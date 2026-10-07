import { DatabaseSync } from 'node:sqlite'
import { fromNodeSqlite, migrate } from '@sidequest/indexer'
import * as sdk from '@sidequest/sdk'
import { afterEach, expect, it } from 'vitest'
import { jobsOfBoard, jobsWithBoards, jobWithBoard, migrateRegistry, recordOffer } from '../src/registry.ts'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const retired = '0x1111111111111111111111111111111111111111'

async function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const sql = fromNodeSqlite(db)
  await migrate(sql); await migrateRegistry(sql)
  const deployment = sdk.deployment('monad-testnet')
  for (const [jobId, holding] of [['62', retired], ['80', deployment.stacks.main!.holding], ['81', null]] as const) {
    db.prepare("INSERT INTO jobs (chain_id,job_id,stack,status,policy_hash,updated_block) VALUES (?,?,'main','submitted',?,1)").run(deployment.chainId, jobId, `policy-${jobId}`)
    if (holding !== null) db.prepare('INSERT INTO events (chain_id,contract,block,log_index,tx_hash,job_id,name,args_json) VALUES (?,?,1,?,?,?,\'Published\',\'{}\')')
      .run(deployment.chainId, holding.toUpperCase(), Number(jobId), `publish-${jobId}`, jobId)
    await recordOffer(sql, { boardId: 'public', termsHash: `policy-${jobId}`, taskId: `task-${jobId}`, now: 0 })
  }
  db.prepare('INSERT INTO evidence (chain_id,job_id,block,log_index,verifier,digest,submission_hash,policy_hash,tested_sha,conclusion,valid_until,matches_onchain,tx_hash) VALUES (?,\'62\',2,0,\'verifier\',\'digest\',\'delivery\',\'policy-62\',\'sha\',1,2000,1,\'evidence-tx\')').run(deployment.chainId)
  return { db, sql, deployment }
}

it('discovery uses the original Holding, keeps the current v1 jobs and filters before the limit', async () => {
  const f = await fixture()
  expect((await jobsWithBoards(f.sql, f.deployment)).map(job => job.job_id)).toEqual(['80'])
  expect((await jobsOfBoard(f.sql, f.deployment, 'public', 1)).map(job => job.job_id)).toEqual(['80'])
  expect(await jobsOfBoard(f.sql, f.deployment, 'another')).toEqual([])
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 3 })
})

it('direct archived reads explicitly refuse actions and preserve the old job, evidence and timeline', async () => {
  const f = await fixture()
  const result = await jobWithBoard(f.sql, f.deployment, '62', 1000)
  expect(result).toMatchObject({ ok: false, code: 'unavailable', message: expect.stringContaining('archived job'),
    availability: { status: 'archived', actionable: false, holding: retired },
    job: { job_id: '62', status: 'submitted' }, board: { taskId: 'task-62' },
    evidence: [{ tx_hash: 'evidence-tx', onchainMatch: true }], timeline: [{ name: 'Published', txHash: 'publish-62' }] })
  expect(await jobWithBoard(f.sql, f.deployment, '80', 1000)).toMatchObject({ ok: true, availability: { status: 'active', actionable: true } })
  expect(await jobWithBoard(f.sql, f.deployment, '81', 1000)).toMatchObject({ ok: false, code: 'unavailable', availability: { status: 'unavailable', actionable: false, holding: null } })
  expect(await jobWithBoard(f.sql, f.deployment, '999', 1000)).toMatchObject({ ok: false, code: 'not-found' })
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 1 })
})
