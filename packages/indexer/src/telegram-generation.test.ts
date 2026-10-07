import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { fixtureDeployment } from '../test/fixtures/v1-logs.ts'
import {
  contractsFromDeployment,
  fromNodeSqlite,
  migrate,
  releaseLease,
  runOnce,
  stmt,
  type AsyncSql,
  type IndexerConfig,
} from './index.ts'
import { drainTelegramOutbox, enqueuePublicRequest, enqueueTelegram, migrateTelegram } from './telegram.ts'
import { queueTelegramNotifications } from './telegram-notifications.ts'

const old = contractsFromDeployment(fixtureDeployment)
const fresh = contractsFromDeployment({ ...fixtureDeployment, core: '0x000000000000000000000000000000000000abcd' })
const config = (contracts = old, deployBlock = 100): IndexerConfig => ({
  contracts,
  deployBlock,
  runner: 'notifications',
  now: () => 1000,
  maxPages: 1,
  head: { finalizedBlock: async () => 200, blockHash: async () => null },
  source: { logs: async () => ({ logs: [], nextBlock: 201 }) },
})
async function database() {
  const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
  await migrate(sql)
  await migrateTelegram(sql)
  await runOnce(sql, config())
  return sql
}
async function published(sql: AsyncSql, core: string, block: number) {
  await sql.batch([
    stmt("INSERT INTO jobs (chain_id, job_id, status, updated_block) VALUES (?, '1', 'open', ?)", old.chainId, block),
    stmt(
      "INSERT INTO events (chain_id, contract, block, log_index, tx_hash, job_id, name, args_json) VALUES (?, ?, ?, 0, ?, '1', 'Published', '{}')",
      old.chainId,
      core,
      block,
      `tx-${block}`,
    ),
    stmt('INSERT INTO block_times (chain_id, block, timestamp) VALUES (?, ?, 1000)', old.chainId, block),
  ])
}

it('queues and delivers reused job 1 after cutover while preserving both old sent rows', async () => {
  const sql = await database()
  await enqueueTelegram(sql, { id: 'telegram:request:public:1', chatId: '-100123', text: 'legacy job 1', now: 999 })
  const sent: string[] = []
  const transport = {
    sendMessage: async (_chat: string, text: string) => {
      sent.push(text)
      return { messageId: sent.length }
    },
  }
  await drainTelegramOutbox(sql, transport, 1000)
  await published(sql, old.core, 100)
  await queueTelegramNotifications(sql, 'monad-testnet', 1000, { channel: '-100123' })
  expect((await drainTelegramOutbox(sql, transport, 1000)).sent).toBe(1)
  const history = await sql.all('SELECT * FROM telegram_outbox ORDER BY id')
  expect(history).toHaveLength(2)
  await releaseLease(sql, config())
  expect(await runOnce(sql, config(fresh, 200))).toMatchObject({ cutover: true })
  await published(sql, fresh.core, 200)
  await queueTelegramNotifications(sql, 'monad-testnet', 1001, { channel: '-100123' })
  expect((await drainTelegramOutbox(sql, transport, 1001)).sent).toBe(1)
  expect(await sql.all('SELECT * FROM telegram_outbox WHERE created_at <= 1000 ORDER BY id')).toEqual(history)
  expect(await sql.all('SELECT id, status FROM telegram_outbox WHERE created_at = 1001')).toEqual([
    { id: `telegram:request:${fresh.core}:public:1`, status: 'sent' },
  ])
  expect(sent).toHaveLength(3)
})

it('publication deduplication ignores core address case', async () => {
  const sql = await database()
  const input = {
    boardId: 'public',
    taskId: '1',
    network: 'monad-testnet' as const,
    now: 1000,
    kind: 'job' as const,
    coreAddress: fresh.core,
  }
  await enqueuePublicRequest(sql, '-100123', input)
  await enqueuePublicRequest(sql, '-100123', { ...input, coreAddress: fresh.core.toUpperCase() })
  expect(await sql.all('SELECT id FROM telegram_outbox')).toEqual([{ id: `telegram:request:${fresh.core}:public:1` }])
})

it('off-chain quote request deduplication keeps its existing board and request identity', async () => {
  const sql = await database()
  const input = {
    boardId: 'tenant',
    taskId: 'request-1',
    network: 'monad-testnet' as const,
    now: 1000,
    kind: 'quotes' as const,
  }
  await enqueuePublicRequest(sql, '-100123', input)
  await enqueuePublicRequest(sql, '-100123', input)
  expect(await sql.all('SELECT id FROM telegram_outbox')).toEqual([{ id: 'telegram:request:tenant:request-1' }])
})
