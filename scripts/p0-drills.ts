import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '../packages/sdk/src/index.ts'
import { contractsOf, DERIVED_TABLES, fromNodeSqlite, migrate, resetIndex, rpcHead, runOnce, type IndexerConfig, type LogSource, type RawLog } from '../packages/indexer/src/index.ts'
import fixture from '../packages/indexer/test/fixtures/testnet-logs.json' with { type: 'json' }
import { migrateRegistry } from '../apps/api/src/registry.ts'
import { SessionDesk } from '../packages/board/src/index.ts'

const args = process.argv.slice(2)
if (args.some(arg => arg !== '--live-testnet')) throw new Error('drill permits only local cassette or --live-testnet read-only RPC; no remote D1 flags')
const live = args.includes('--live-testnet')
const root = mkdtempSync(join(tmpdir(), 'sidequest-e38-recovery-'))
const started = Date.now()
let sourceDb: DatabaseSync | undefined
let restoredDb: DatabaseSync | undefined
try {
  sourceDb = new DatabaseSync(join(root, 'source.sqlite'))
  const sql = fromNodeSqlite(sourceDb)
  await migrate(sql)
  await migrateRegistry(sql)
  await new SessionDesk({ sql, now: () => 1_800_000_000, verify: async () => false }).migrate()
  sourceDb.exec("CREATE TABLE e38_hosted_fixture (id TEXT PRIMARY KEY, body TEXT); INSERT INTO e38_hosted_fixture VALUES ('retain', 'hosted-only')")
  const contracts = contractsOf('monad-testnet')
  const deployBlock = Number(sdk.deployment('monad-testnet').deployBlock)
  const rpc = process.env.MONAD_TESTNET_RPC_URL || 'https://testnet-rpc.monad.xyz'
  const rpcCall = async (method: string, params: unknown[]) => {
    const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const body = await response.json() as { result?: unknown; error?: { message?: string } }
    if (body.error !== undefined) throw new Error(`RPC ${method} failed: ${body.error.message ?? 'unknown'}`)
    return body.result
  }
  const liveHead = rpcHead(rpc)
  const cutoff = live ? Math.min(await liveHead.finalizedBlock() + 1, deployBlock + 8000) : fixture.toBlock
  if (live && Number(await rpcCall('eth_chainId', [])) !== 10143) throw new Error('drill RPC must be Monad testnet')
  const source: LogSource = live ? {
    async logs(query) {
      const nextBlock = Math.min(query.toBlock, query.fromBlock + 100)
      const logs = await rpcCall('eth_getLogs', [{ address: query.addresses, fromBlock: `0x${query.fromBlock.toString(16)}`, toBlock: `0x${(nextBlock - 1).toString(16)}` }]) as Array<{ blockNumber: string; logIndex: string; transactionHash: string; address: string; data: string; topics: string[] }>
      return { nextBlock, logs: logs.map(log => ({
        block_number: Number(BigInt(log.blockNumber)), log_index: Number(BigInt(log.logIndex)), transaction_hash: log.transactionHash,
        address: log.address, data: log.data, topic0: log.topics[0], topic1: log.topics[1], topic2: log.topics[2], topic3: log.topics[3],
      })) as RawLog[] }
    },
  } : {
    async logs(query) {
      const nextBlock = Math.min(query.toBlock, cutoff)
      return { nextBlock, logs: (fixture.logs as RawLog[]).filter(log => log.block_number >= query.fromBlock && log.block_number < nextBlock) }
    },
  }
  const config: IndexerConfig = {
    contracts, deployBlock, source, runner: 'e38-disposable-drill', maxPages: 80, backfillBlocks: 0,
    head: live ? { ...liveHead, finalizedBlock: async () => cutoff - 1 } : {
      finalizedBlock: async () => cutoff - 1,
      blockHash: async block => `0x${block.toString(16).padStart(64, '0')}`,
    },
  }
  const indexed = await runOnce(sql, config)
  if (indexed.events === 0 || indexed.nextBlock !== cutoff) throw new Error('bounded index did not finish with decoded chain events')
  const tables = ['events', ...DERIVED_TABLES, 'checkpoint', 'block_times']
  const snapshot = (database: DatabaseSync) => Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
  const before = snapshot(sourceDb)
  sourceDb.exec(`VACUUM INTO '${join(root, 'restore.sqlite')}'`)
  restoredDb = new DatabaseSync(join(root, 'restore.sqlite'))
  if (JSON.stringify(snapshot(restoredDb)) !== JSON.stringify(before)) throw new Error('snapshot restore differs from source')
  const restored = fromNodeSqlite(restoredDb)
  await resetIndex(restored, config)
  const rebuilding = await runOnce(restored, config)
  if (rebuilding.nextBlock !== cutoff) throw new Error('rebuild did not reach bounded checkpoint')
  const after = snapshot(restoredDb)
  delete before.checkpoint
  delete after.checkpoint
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('chain-derived rows differ after rebuild')
  const hosted = restoredDb.prepare('SELECT body FROM e38_hosted_fixture WHERE id = ?').get('retain') as { body: string }
  if (hosted.body !== 'hosted-only') throw new Error('rebuild lost hosted state')
  console.log(JSON.stringify({ ok: true, storage: 'disposable SQLite using real D1 schema/adapters', source: live ? 'read-only Monad testnet RPC' : 'recorded testnet logs', chainId: 10143, fromBlock: deployBlock, nextBlock: cutoff, events: indexed.events, jobs: indexed.jobs, restored: true, rebuilt: true, hostedRowsRetained: true, elapsedMs: Date.now() - started }))
} finally {
  restoredDb?.close()
  sourceDb?.close()
  rmSync(root, { recursive: true, force: true })
}
