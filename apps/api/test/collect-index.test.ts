import { DatabaseSync } from 'node:sqlite'
import { fromNodeSqlite, migrate } from '@agent-jobs/indexer'
import * as sdk from '@agent-jobs/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { collectSnapshot } from '../src/collect-index.ts'

const dbs: DatabaseSync[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })
async function fixture() {
  const db = new DatabaseSync(':memory:'); dbs.push(db)
  const sql = fromNodeSqlite(db); await migrate(sql)
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const hash = `0x${'a'.repeat(64)}`
  const getBlock = vi.fn(async () => ({ hash, timestamp: 1000n }))
  const ctx = { ...base, deployment: { ...base.deployment, deployBlock: 0n }, publicClient: { ...base.publicClient, getBlock } } as unknown as sdk.Ctx
  db.prepare('INSERT INTO checkpoint VALUES (?,?,?,?)').run(base.deployment.chainId, 11, hash, 1000)
  return { db, sql, ctx, getBlock }
}
const wallet = `0x${'b'.repeat(40)}` as const
it('a canonical recent complete index may return an empty list', async () => {
  const f = await fixture()
  expect(await collectSnapshot(f.sql, f.ctx, wallet, 1000)).toEqual({ jobs: [], tokens: [], epochs: [] })
})
it('a partial RPC read fails the entire snapshot', async () => {
  const f = await fixture(); f.getBlock.mockRejectedValueOnce(new Error('RPC unavailable'))
  await expect(collectSnapshot(f.sql, f.ctx, wallet, 1000)).rejects.toThrow('RPC unavailable')
})
it('discovers unique mining epochs only from the configured distributor on this chain', async () => {
  const f = await fixture(), distributor = `0x${'c'.repeat(40)}` as const
  f.ctx = { ...f.ctx, deployment: { ...f.ctx.deployment, hireling: { distributor } } } as unknown as sdk.Ctx
  const insert = f.db.prepare('INSERT INTO protocol_events VALUES (?,?,?,?,?,?,?)')
  insert.run(10143, distributor, 2, 0, 'tx1', 'RootSet', '{"epoch":"0"}')
  insert.run(10143, distributor, 3, 0, 'tx2', 'RootSet', '{"epoch":"0"}')
  insert.run(10143, distributor, 4, 0, 'tx3', 'RootSet', '{"epoch":"1"}')
  insert.run(143, distributor, 4, 0, 'tx4', 'RootSet', '{"epoch":"2"}')
  insert.run(10143, wallet, 4, 0, 'tx5', 'RootSet', '{"epoch":"3"}')
  expect(await collectSnapshot(f.sql, f.ctx, wallet, 1000)).toEqual({ jobs: [], tokens: [], epochs: ['0', '1'] })
})
it('a changing checkpoint or a lagging finalized block refuses discovery', async () => {
  const f = await fixture()
  f.getBlock.mockImplementationOnce(async () => { f.db.prepare('UPDATE checkpoint SET next_block=12').run(); return { hash: `0x${'a'.repeat(64)}`, timestamp: 1000n } })
  await expect(collectSnapshot(f.sql, f.ctx, wallet, 1000)).rejects.toThrow('changed')
  f.getBlock.mockResolvedValueOnce({ hash: `0x${'a'.repeat(64)}`, timestamp: 1121n })
  await expect(collectSnapshot(f.sql, f.ctx, wallet, 1000)).rejects.toThrow('behind')
})
