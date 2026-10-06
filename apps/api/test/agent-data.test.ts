/** `/data/agents/<id>` over a real SQLite index: the current agent wallet's posted jobs, boards and registry answers. */
import { DatabaseSync } from 'node:sqlite'
import { fromNodeSqlite, migrate } from '@sidequest/indexer'
import * as sdk from '@sidequest/sdk'
import { type Address, ContractFunctionRevertedError, zeroAddress } from 'viem'
import { afterEach, expect, it } from 'vitest'
import { agentDataBody, currentIdentity, type IdentityReads } from '../src/routes/agent-data.ts'
import { migrateRegistry, recordOffer } from '../src/registry.ts'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const chainId = sdk.deployment('monad-testnet').chainId
const agentWallet = '0x7c914D40E7D08872FD0239eA8DBe0584aB361C81' as Address
const other = '0x2222222222222222222222222222222222222222' as Address

async function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const sql = fromNodeSqlite(db)
  await migrate(sql); await migrateRegistry(sql)
  const job = db.prepare("INSERT INTO jobs (chain_id,job_id,stack,kind,mode,status,creator,token,reward,policy_hash,published_block,updated_block) VALUES (?,?,'main','sidequest-v1','hire',?,?,?,'5000000',?,?,?)")
  // Agent 2013's wallet posted two jobs (checksummed, as the indexer stores it); another wallet posted one more.
  job.run(chainId, '130', 'open', agentWallet, other, '0xAAAA', 10, 10)
  job.run(chainId, '131', 'active', agentWallet, other, '0xBBBB', 12, 13)
  job.run(chainId, '132', 'open', other, other, '0xCCCC', 14, 14)
  await recordOffer(sql, { boardId: 'acme', termsHash: '0xbbbb', taskId: 'task-131', now: 0 })
  return sql
}

const revert = () => new ContractFunctionRevertedError({ abi: sdk.identityAbi, functionName: 'ownerOf', message: 'ERC721NonexistentToken' })
const registry = (wallets: Record<string, Address>): IdentityReads => ({
  owner: async (id) => { if (wallets[id.toString()] === undefined) throw revert(); return other },
  wallet: async (id) => wallets[id.toString()] ?? zeroAddress,
})

it('counts the jobs the current agent wallet posted, each with its board, before the agent takes any', async () => {
  const sql = await fixture()
  const body = await agentDataBody(sql, chainId, '2013', registry({ '2013': agentWallet }))
  expect(body).toMatchObject({ ok: true, registered: true, currentWallet: agentWallet, jobs: [], hiring: { posted: 2, open: 2, paidOut: {} } })
  if (!body.ok) throw new Error('expected a record')
  expect(body.agent).toMatchObject({ agentId: '2013', jobs: 0, completed: 0 })
  expect(body.posted.map((j) => [j.job_id, j.board_id])).toEqual([['131', 'acme'], ['130', null]])
})

it('answers a registered agent with no jobs with an empty record, and an unregistered number with not-found', async () => {
  const sql = await fixture()
  const empty = await agentDataBody(sql, chainId, '1942', registry({ '1942': zeroAddress }))
  expect(empty).toMatchObject({ ok: true, registered: true, currentWallet: null, posted: [], jobs: [], time: { activeSince: null, turnarounds: 0 } })
  expect(await agentDataBody(sql, chainId, '77', registry({}))).toMatchObject({ ok: false, code: 'not-found' })
  // No chain configured: the record still answers from the index alone, and an unknown agent is not-found.
  expect(await agentDataBody(sql, chainId, '2013', undefined)).toMatchObject({ ok: false, code: 'not-found' })
})

it('treats a slow or failing registry as unknown, never as "not registered"', async () => {
  const hang: IdentityReads = { owner: () => new Promise(() => {}), wallet: () => new Promise(() => {}) }
  expect(await currentIdentity(hang, 1n, 20)).toEqual({ registered: null, wallet: null })
  const down: IdentityReads = { owner: async () => { throw new Error('fetch failed') }, wallet: async () => agentWallet }
  expect(await currentIdentity(down, 1n)).toEqual({ registered: null, wallet: null })
  expect(await currentIdentity(registry({ '5': agentWallet }), 5n)).toEqual({ registered: true, wallet: agentWallet })
  expect(await currentIdentity(registry({}), 5n)).toEqual({ registered: false, wallet: null })
})
