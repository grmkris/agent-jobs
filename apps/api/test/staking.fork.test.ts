/** Real generated vault logs, SQLite discovery and canonical Monad fork reads. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { Board, fromNodeSqlite as boardSql } from '@sidequest/board'
import { fromNodeSqlite, migrate, stmt, contractsFromDeployment, decode } from '@sidequest/indexer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeFunctionData, parseEther } from 'viem'
import { forkEnabled, forkSetupTimeout, startSidequestFork } from '../../../packages/sdk/test/sidequest-fixture.ts'
import { backingCard, stakingSnapshot } from '../src/staking-index.ts'
import { collectSnapshot } from '../src/collect-index.ts'
import { tools } from '../src/tools.ts'
import { permittedTool } from '../src/mcp-policy.ts'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { stakingDataRoute } from '../src/routes/staking.ts'

const fork = forkEnabled ? describe : describe.skip
fork('delegated backing API with a checked real event index', () => {
  let f: Awaited<ReturnType<typeof startSidequestFork>>
  let db: DatabaseSync
  let serviceDb: DatabaseSync
  let board: Board
  let start: bigint
  let clock: number
  beforeAll(async () => {
    f = await startSidequestFork()
    start = await f.ctx.publicClient.getBlockNumber()
    db = new DatabaseSync(':memory:')
    serviceDb = new DatabaseSync(':memory:')
    await migrate(fromNodeSqlite(db))
    board = new Board(boardSql(serviceDb), {
      network: 'monad-testnet',
      contexts: { main: f.ctx },
      domain: 'fork',
      uri: 'https://fork',
      manifestBaseUrl: '',
      delegationSnapshot: (filters) => stakingSnapshot(fromNodeSqlite(db), f.ctx, filters, clock),
      collectSnapshot: (wallet) => collectSnapshot(fromNodeSqlite(db), f.ctx, wallet, clock),
    })
    await sdk.delegate(f.ctx, f.creator, parseEther('30'), f.worker.account.address)
    await sdk.delegate(f.ctx, f.worker, parseEther('20'))
    await indexNow()
  }, forkSetupTimeout())
  afterAll(() => {
    db?.close()
    serviceDb?.close()
    f?.close()
  })

  async function indexNow() {
    const block = await f.ctx.publicClient.getBlock()
    clock = Number(block.timestamp)
    const contracts = contractsFromDeployment(f.ctx.deployment)
    const logs = await f.ctx.publicClient.getLogs({
      address: f.ctx.deployment.sidequest!.vault,
      fromBlock: start,
      toBlock: block.number,
    })
    const events = logs.map((l) =>
      decode(contracts, {
        address: l.address,
        block_number: Number(l.blockNumber),
        log_index: l.logIndex,
        transaction_hash: l.transactionHash,
        topic0: l.topics[0] ?? null,
        topic1: l.topics[1] ?? null,
        topic2: l.topics[2] ?? null,
        topic3: l.topics[3] ?? null,
        data: l.data,
      }),
    )
    const sql = fromNodeSqlite(db)
    await sql.batch(
      events.flatMap((e) =>
        e === undefined
          ? []
          : [
              stmt(
                'INSERT OR REPLACE INTO protocol_events VALUES (?,?,?,?,?,?,?)',
                e.chainId,
                e.contract,
                e.block,
                e.logIndex,
                e.txHash,
                e.name,
                JSON.stringify(e.args),
              ),
            ],
      ),
    )
    await sql.batch([
      stmt(
        'INSERT OR REPLACE INTO checkpoint (chain_id,next_block,block_hash,updated_at) VALUES (?,?,?,?)',
        f.ctx.deployment.chainId,
        Number(block.number + 1n),
        block.hash,
        clock,
      ),
    ])
  }

  it('exposes outside ownership, aggregate backing and the owner position through public and MCP reads', async () => {
    const wallet = f.creator.account.address
    const account = f.worker.account.address
    const positions = await board.listDelegations({ address: wallet }, {})
    expect(positions.positions).toHaveLength(1)
    expect(positions.positions[0]).toMatchObject({
      account,
      delegator: wallet,
      value: parseEther('30'),
      shareBps: 6000,
      backing: { assets: parseEther('50'), active: parseEther('50') },
    })
    const result = (await tools.list_delegations!.run(
      board,
      {},
      { account },
      { network: 'monad-testnet', mcpSession: undefined },
    )) as Awaited<ReturnType<Board['listDelegations']>>
    expect(result.positions).toHaveLength(2)
    expect(permittedTool({ scopes: ['sidequest:read'] }, 'list_delegations')).toBe(true)
    expect(await backingCard(fromNodeSqlite(db), f.ctx, account, wallet, clock)).toMatchObject({
      assets: parseEther('50'),
      delegatorCount: 2,
      position: { value: parseEther('30'), shareBps: 6000 },
    })
  })

  it('VV2-005 both public routes parse populated and empty results through their real HTTP response path', async () => {
    const wallet = f.creator.account.address
    const account = f.worker.account.address
    const empty = f.arbitrator.account.address
    for (const [path, expected] of [
      [`/data/delegations?wallet=${wallet}`, { positions: [{ value: parseEther('30').toString() }] }],
      [`/data/delegations?wallet=${empty}`, { positions: [] }],
      [`/data/backing/${account}?wallet=${wallet}`, { assets: parseEther('50').toString(), delegatorCount: 2 }],
      [`/data/backing/${empty}?wallet=${wallet}`, { assets: '0', delegatorCount: 0, topDelegators: [] }],
    ] as const) {
      const response = HttpServerResponse.toWeb(
        await stakingDataRoute(fromNodeSqlite(db), f.ctx, new URL(path, 'https://fork'), clock),
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as { blockNumber: string }
      expect(body).toMatchObject({ ok: true, ...expected })
      expect(body.blockNumber).toMatch(/^\d+$/)
    }
  })

  it('pins indexed values to the checkpoint and refuses a divergent or stale checkpoint', async () => {
    const account = f.worker.account.address
    const snapshot = await stakingSnapshot(fromNodeSqlite(db), f.ctx, { account }, clock)
    await sdk.delegate(f.ctx, f.creator, parseEther('1'), account)
    expect((await backingCard(fromNodeSqlite(db), f.ctx, account, undefined, clock)).assets).toBe(parseEther('50'))
    expect(snapshot.candidates).toHaveLength(2)
    await indexNow()
    await expect(stakingSnapshot(fromNodeSqlite(db), f.ctx, { account }, clock + 121)).rejects.toThrow('behind')
    db.prepare('UPDATE checkpoint SET block_hash=?').run(`0x${'00'.repeat(32)}`)
    await expect(stakingSnapshot(fromNodeSqlite(db), f.ctx, { account }, clock)).rejects.toThrow('divergent')
    await indexNow()
  })

  it('Collect discovers and withdraws an outside position to its owner after cooldown', async () => {
    const wallet = f.creator.account.address
    const account = f.worker.account.address
    await sdk.requestUndelegate(f.ctx, f.creator, parseEther('31'), account)
    const queued = await sdk.getPosition(f.ctx, account, wallet)
    await indexNow()
    expect((await board.collectActions({}, { wallet })).filter((a) => a.kind === 'stakeWithdraw')).toHaveLength(0)
    await f.rpc('evm_setNextBlockTimestamp', [queued.unlockAt + 1])
    await f.rpc('evm_mine')
    await indexNow()
    const action = (await board.collectActions({}, { wallet })).find((a) => a.kind === 'stakeWithdraw')!
    expect(action).toMatchObject({ account, amount: parseEther('31').toString() })
    expect(decodeFunctionData({ abi: sdk.stakeVaultAbi, data: action.transactions[0]!.data }).args).toEqual([account])
    const before = await sdk.balanceOf(f.ctx, f.ctx.stack.factory, wallet)
    await sdk.sendAll(f.creator, f.ctx.publicClient, action.transactions)
    expect((await sdk.balanceOf(f.ctx, f.ctx.stack.factory, wallet)) - before).toBe(parseEther('31'))
    expect((await sdk.getPosition(f.ctx, account, f.worker.account.address)).value).toBe(parseEther('20'))
  }, 120_000)
})
