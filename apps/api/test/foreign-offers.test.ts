import { DatabaseSync } from 'node:sqlite'
import { canonicalJson, termsHash, type OfferTerms } from '@sidequest/board'
import {
  fromNodeSqlite,
  hydrateForeignOffers,
  migrate,
  networkStats,
  readInbox,
  stmt,
  writeFeed,
} from '@sidequest/indexer'
import { deployment } from '@sidequest/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { jobsWithBoards, jobWithBoard, migrateRegistry, recordOffer } from '../src/registry.ts'

const d = deployment('monad-testnet'),
  host = 'https://dev.sidequest.exchange',
  own = 'https://sidequest.exchange'
const terms: OfferTerms = {
  v: 2,
  mode: 'hire',
  taskId: 'remote-task',
  projectId: null,
  policyVersion: null,
  title: 'Another board’s job',
  brief: 'Shared frozen brief.',
  acceptanceCriteria: ['Read it anywhere'],
  deployment: { chainId: d.chainId, core: d.core, ...d.stacks.main!, identity: d.identity },
  token: d.rewardTokens[0]!,
  reward: 100n,
  creatorBond: 0n,
  workerBond: 0n,
  deliveryDeadline: 10000,
  creator: d.admin,
  approver: d.admin,
  arbitrator: d.arbitrator,
  windows: { reviewSeconds: 3600, disputeSeconds: 3600, arbitrationSeconds: 43200 },
  eligibility: null,
  evidencePolicy: null,
  quote: null,
  salt: `0x${'01'.repeat(32)}`,
}
const hash = termsHash(terms),
  databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
async function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  await migrate(sql)
  await migrateRegistry(sql)
  await sql.batch([
    stmt(
      "INSERT INTO jobs (chain_id,job_id,stack,kind,status,manifest_hash,policy_hash,reward,token,updated_block) VALUES (?,'7','main','sidequest-v1','open',?,?, '100',?,1)",
      d.chainId,
      hash,
      `0x${'ff'.repeat(32)}`,
      terms.token,
    ),
    stmt(
      "INSERT INTO events VALUES (?, ?, 1, 0, 'tx', '7', 'Published', ?)",
      d.chainId,
      d.stacks.main!.holding,
      JSON.stringify({ manifestHash: hash }),
    ),
  ])
  const request = vi.fn<typeof fetch>(async () => new Response(canonicalJson(terms)))
  await hydrateForeignOffers(sql, d.chainId, { boards: [host], origin: own, fetch: request }, 1000)
  return { sql, request }
}

it('reads a verified foreign offer in the list and job detail, using the manifest hash instead of the evidence policy', async () => {
  const f = await fixture()
  expect(await jobsWithBoards(f.sql, d)).toMatchObject([
    {
      job_id: '7',
      board_id: null,
      foreign_offer: {
        origin: host,
        termsHash: hash,
        terms: { title: terms.title, brief: terms.brief, reward: '100' },
      },
    },
  ])
  expect(await jobWithBoard(f.sql, d, '7', 1000)).toMatchObject({
    ok: true,
    board: null,
    foreign_offer: { origin: host, termsHash: hash, terms: { acceptanceCriteria: ['Read it anywhere'] } },
  })
  expect(await networkStats(f.sql, d.chainId)).toMatchObject({ jobs: 1, inEscrow: { [terms.token]: '100' } })
  expect(f.request).toHaveBeenCalledTimes(1)
})

it('prefers a local board row and leaves missing offers available as chain jobs', async () => {
  const f = await fixture()
  await recordOffer(f.sql, { boardId: 'public', termsHash: hash, taskId: 'local-task', now: 1000 })
  expect((await jobsWithBoards(f.sql, d))[0]?.foreign_offer).toBeUndefined()
  expect(await jobWithBoard(f.sql, d, '7', 1000)).toMatchObject({
    board: { boardId: 'public', taskId: 'local-task' },
    foreign_offer: null,
  })
  await f.sql.batch([stmt('DELETE FROM board_offers'), stmt('DELETE FROM foreign_offers')])
  expect(await jobWithBoard(f.sql, d, '7', 1000)).toMatchObject({ ok: true, board: null, foreign_offer: null })
})

it('enriches feed reads without rewriting notifications, summaries, next actions or host attribution', async () => {
  const f = await fixture()
  const event = {
    id: 'foreign-published',
    address: '*',
    kind: 'job.published',
    jobId: '7',
    summary: 'Job #7 published.',
    url: `${own}/job/7`,
    occurredAt: 1000,
  }
  await writeFeed(f.sql, 'monad-testnet', [event], 1000)
  const page = await readInbox(f.sql, { network: 'monad-testnet', address: d.admin, now: 1000 })
  expect(page.events[0]).toMatchObject({
    summary: event.summary,
    url: event.url,
    boardId: null,
    taskId: null,
    foreignOffer: { origin: host, terms: { title: terms.title, brief: terms.brief } },
  })
  expect(page.events[0]?.next).toBeUndefined()
  expect(await f.sql.all('SELECT data_json FROM feed_events')).toEqual([
    { data_json: JSON.stringify({ summary: event.summary, url: event.url }) },
  ])
})
