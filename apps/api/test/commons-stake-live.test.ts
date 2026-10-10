import { Effect } from 'effect'
import { expect, it, vi } from 'vitest'
import * as sdk from '@sidequest/sdk'
import { Unavailable } from '@sidequest/commons'
import { stakeReaderLive } from '../src/commons/stake-live.ts'

const address = '0x1111111111111111111111111111111111111111'
const emptySql = { all: async <T>() => new Array<T>(), batch: async () => {} }
function fixture(failing = false) {
  const ctx = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const multicall = vi.fn(async (input: { contracts: readonly object[] }) => {
    if (failing) throw new Error('offline')
    return input.contracts.map(() => 42n)
  })
  // SAFETY: this unit double supplies only the two public-client methods used by active-stake reads.
  const context = {
    ...ctx,
    publicClient: { ...ctx.publicClient, getBlockNumber: vi.fn(async () => 99n), multicall },
  } as sdk.Ctx
  return { reader: stakeReaderLive(emptySql, context), multicall, client: context.publicClient }
}

it('pins one stake multicall to one block', async () => {
  const f = fixture()
  expect(await Effect.runPromise(f.reader.stakes([address]))).toEqual({ block: 99n, stake: new Map([[address, 42n]]) })
  expect(f.multicall).toHaveBeenCalledOnce()
  expect(f.multicall.mock.calls[0]?.[0]).toMatchObject({ allowFailure: false, blockNumber: 99n })
})

it('chunks addresses into batches of 200, all at the same block', async () => {
  const f = fixture()
  const addresses = Array.from({ length: 401 }, (_, index) => `0x${index.toString(16).padStart(40, '0')}`)
  const read = await Effect.runPromise(f.reader.stakes(addresses))
  expect(read.stake.size).toBe(401)
  expect(f.multicall.mock.calls.map(([input]) => input.contracts.length)).toEqual([200, 200, 1])
  for (const [input] of f.multicall.mock.calls) expect(input).toMatchObject({ blockNumber: 99n })
  expect(f.client.getBlockNumber).toHaveBeenCalledOnce()
})

it('maps RPC failure to Unavailable instead of returning zero stake', async () => {
  const result = await Effect.runPromise(fixture(true).reader.stakes([address]).pipe(Effect.flip))
  expect(result).toBeInstanceOf(Unavailable)
})

it('reads delegated backing from one verified index snapshot and block', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { fromNodeSqlite, migrate } = await import('@sidequest/indexer')
  const db = new DatabaseSync(':memory:')
  const sql = fromNodeSqlite(db)
  await migrate(sql)
  const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const account = '0x2222222222222222222222222222222222222222'
  const hash = `0x${'a'.repeat(64)}`
  const vault = base.deployment.sidequest!.vault
  const block = Number(base.deployment.sidequest!.block) + 100
  const now = Math.floor(Date.now() / 1000)
  const delegation = { account, delegator: address }
  db.prepare('INSERT INTO checkpoint (chain_id,next_block,block_hash,updated_at) VALUES (?,?,?,?)').run(
    base.deployment.chainId,
    block + 1,
    hash,
    now,
  )
  db.prepare('INSERT INTO protocol_events VALUES (?,?,?,?,?,?,?)').run(
    base.deployment.chainId,
    vault,
    block - 1,
    0,
    '0xreceipt',
    'Delegated',
    JSON.stringify(delegation),
  )
  const readContract = vi.fn(async ({ functionName }: { functionName: string; blockNumber?: bigint }) => {
    if (functionName === 'poolOf')
      return { assets: 1000n, reserved: 0n, shares: 1000n, queuedShares: 0n, generation: 0n }
    if (functionName === 'schedule') return { thresholds: [0n], bps: [0] }
    if (functionName === 'positionOf') return { shares: 25n, queuedShares: 0n, unlockAt: 0, generation: 0n }
    throw new Error(`unexpected ${functionName}`)
  })
  // SAFETY: the snapshot verifier reads only hash and timestamp from these blocks.
  const checkpointBlock = { hash, timestamp: BigInt(now) } as Awaited<ReturnType<sdk.Ctx['publicClient']['getBlock']>>
  const getBlock: sdk.Ctx['publicClient']['getBlock'] = vi.fn().mockResolvedValue(checkpointBlock)
  const client = {
    ...base.publicClient,
    readContract,
    getBlock,
  }
  // SAFETY: the test client implements the pinned staking reads needed by the backing adapter.
  const ctx = { ...base, publicClient: client } as sdk.Ctx
  const reader = stakeReaderLive(sql, ctx)
  await expect(Effect.runPromise(reader.backing(address))).resolves.toMatchObject({ block: BigInt(block), total: 25n })
  expect(readContract.mock.calls.every(([input]) => input.blockNumber === BigInt(block))).toBe(true)
  db.close()
})
