import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { encodeAbiParameters, encodeEventTopics, isHex, keccak256, stringToHex } from 'viem'
import { afterEach, expect, it, vi } from 'vitest'
import { contractsFromDeployment, decode, type RawLog } from './events.ts'
import { runOnce, releaseLease } from './indexer.ts'
import { hyperSync, type LogSource } from './source.ts'
import { fromNodeSqlite, migrate, stmt } from './store.ts'

const deployment = sdk.deployment('monad-testnet')
const contracts = contractsFromDeployment(deployment)
const hash = `0x${'ab'.repeat(32)}` as const
function metadata(block: number, key = sdk.BACKER_SHARE_KEY): RawLog {
  const topics = encodeEventTopics({
    abi: sdk.identityAbi,
    eventName: 'MetadataSet',
    args: { agentId: 7n, indexedMetadataKey: key },
  })
  return {
    address: deployment.identity,
    block_number: block,
    log_index: 2,
    transaction_hash: hash,
    topic0: topics[0],
    topic1: isHex(topics[1]) ? topics[1] : null,
    topic2: isHex(topics[2]) ? topics[2] : null,
    data: encodeAbiParameters([{ type: 'string' }, { type: 'bytes' }], [key, sdk.encodeBackerShare(5000)]),
  }
}
afterEach(() => vi.unstubAllGlobals())

it('decodes only the backer-share metadata key, preserving agent, value and chain position', () => {
  expect(decode(contracts, metadata(101))).toMatchObject({
    block: 101,
    logIndex: 2,
    txHash: hash,
    jobId: null,
    name: 'MetadataSet',
    args: { agentId: '7', metadataKey: sdk.BACKER_SHARE_KEY, metadataValue: sdk.encodeBackerShare(5000) },
  })
  expect(decode(contracts, metadata(101, 'name'))).toBeUndefined()
  expect(
    decode(contracts, { ...metadata(101, 'name'), topic2: keccak256(stringToHex(sdk.BACKER_SHARE_KEY)) }),
  ).toBeUndefined()
})

it('selects registry metadata by event signature and indexed key without filtering job contracts', async () => {
  const request = vi.fn(async (_input: string, _init?: RequestInit) => Response.json({ data: [], next_block: 102 }))
  vi.stubGlobal('fetch', request)
  await hyperSync('https://index.invalid', 'test-only', deployment.identity).logs({
    fromBlock: 100,
    toBlock: 102,
    addresses: [deployment.core, deployment.identity],
  })
  const init = request.mock.calls[0]?.[1]
  expect(init).toBeDefined()
  expect(init?.body).toEqual(expect.stringContaining(JSON.stringify({ address: [deployment.core] })))
  expect(init?.body).toEqual(
    expect.stringContaining(
      JSON.stringify({
        address: [deployment.identity],
        topics: [
          [keccak256(stringToHex('MetadataSet(uint256,string,string,bytes)'))],
          [],
          [keccak256(stringToHex(sdk.BACKER_SHARE_KEY))],
        ],
      }),
    ),
  )
})

it('backfills an advanced index once, resumes pages, stores times and replays without duplicates', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const sql = fromNodeSqlite(db)
    await migrate(sql)
    await sql.batch([
      stmt(
        'INSERT INTO checkpoint VALUES (?, ?, ?, ?, ?, ?)',
        deployment.chainId,
        106,
        null,
        contracts.core,
        100,
        1000,
      ),
    ])
    const calls: number[] = []
    const source: LogSource = {
      logs: async ({ fromBlock, toBlock, addresses }) => {
        calls.push(fromBlock)
        expect(addresses).toEqual([deployment.identity])
        const nextBlock = Math.min(fromBlock + 2, toBlock)
        return {
          nextBlock,
          logs: [metadata(101), metadata(104)].filter(
            (log) => log.block_number >= fromBlock && log.block_number < nextBlock,
          ),
          blockTimes: [101, 104].map((block) => ({ block, timestamp: 1000 + block })),
        }
      },
    }
    const cfg = {
      contracts,
      deployBlock: 100,
      runner: 'shares',
      now: () => 1000,
      maxPages: 1,
      source,
      head: { finalizedBlock: async () => 105, blockHash: async () => hash },
      backerShareHistory: { identity: deployment.identity, fromBlock: 100 },
    }
    expect(await runOnce(sql, cfg)).toMatchObject({ caughtUp: true })
    await releaseLease(sql, cfg)
    expect(await runOnce(sql, cfg)).toMatchObject({ caughtUp: true })
    expect(await runOnce(sql, cfg)).toMatchObject({ caughtUp: true })
    expect(await runOnce(sql, cfg)).toMatchObject({ caughtUp: true })
    expect(calls).toEqual([100, 102, 104])
    expect(await sql.all('SELECT block, log_index, tx_hash, name FROM protocol_events ORDER BY block')).toEqual(
      [101, 104].map((block) => ({ block, log_index: 2, tx_hash: hash, name: 'MetadataSet' })),
    )
    expect(await sql.all('SELECT block, timestamp FROM block_times ORDER BY block')).toEqual(
      [101, 104].map((block) => ({ block, timestamp: block + 1000 })),
    )
  } finally {
    db.close()
  }
})
