import * as sdk from '@sidequest/sdk'
import { type Address, type Hex, type TransactionReceipt, encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem'
import { expect, it, vi } from 'vitest'
import {
  confirmedOperationEvents,
  confirmedOperationIds,
  confirmsVaultOperation,
  vaultOperationResult,
} from './receipts.ts'
import { DatabaseSync } from 'node:sqlite'
import { Board } from './service.ts'
import { fromNodeSqlite } from './store.ts'
import type { OperationRow, Sql } from './store.ts'
import { confirmOperationEvent } from './operation-receipts.ts'
import { canonicalJson, termsHash, type OfferTerms } from './terms.ts'

const wallet = `0x${'1'.repeat(40)}` as Address,
  relay = `0x${'2'.repeat(40)}` as Address,
  mallory = `0x${'3'.repeat(40)}` as Address
const base = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
const ctx = {
  ...base,
  stack: { ...base.stack, kind: 'sidequest-v1' as const },
  publicClient: { ...base.publicClient, readContract: vi.fn(async () => ({ creator: wallet, approver: wallet })) },
} as unknown as sdk.Ctx
const op = (kind: string, actor: string = wallet, detail?: object): OperationRow => ({
  id: kind + actor,
  kind,
  actor,
  task_id: 'task',
  status: 'prepared',
  tx_hash: null,
  detail: detail === undefined ? null : JSON.stringify(detail),
  created_at: 0,
  updated_at: 0,
})
// SAFETY: unit receipts contain canonical transaction metadata and ABI-encoded logs; unused RPC fields are omitted.
const receipt = (logs: object[]): TransactionReceipt =>
  ({
    status: 'success',
    transactionHash: sdk.hashText('vault receipt'),
    blockNumber: 100n,
    from: relay,
    to: ctx.deployment.delegation.manager,
    logs: logs.map((log, logIndex) => ({ ...log, logIndex })),
  }) as TransactionReceipt
function accepted(approver: Address = wallet, address = ctx.stack.evaluator, jobId = 1n) {
  return {
    address,
    data: '0x' as Hex,
    topics: encodeEventTopics({ abi: sdk.sidequestEvaluatorAbi, eventName: 'Accepted', args: { jobId, approver } }),
  }
}

it('a relay/manager receipt confirms only the decoded event actor and method', async () => {
  const ops = [op('accept'), op('accept', mallory), op('reject'), op('submit')]
  expect(await confirmedOperationIds(ctx, 1n, receipt([accepted()]), ops)).toEqual([op('accept').id])
  expect(await confirmedOperationIds(ctx, 1n, receipt([accepted(mallory)]), ops)).toEqual([op('accept', mallory).id])
})
it('counterfeit contracts, another job, and reverted receipts cannot confirm an operation', async () => {
  for (const r of [
    receipt([accepted(wallet, mallory)]),
    receipt([accepted(wallet, ctx.stack.evaluator, 2n)]),
    { ...receipt([accepted()]), status: 'reverted' as const },
  ])
    expect(await confirmedOperationIds(ctx, 1n, r, [op('accept')])).toEqual([])
})
it('an activation event must match the prepared selection nonce', async () => {
  const log = {
    address: ctx.stack.holding,
    topics: encodeEventTopics({
      abi: sdk.sidequestHoldingAbi,
      eventName: 'Activated',
      args: { jobId: 1n, worker: wallet },
    }),
    data: encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint16' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [4n, 5n, 3000, 3n, 7n, 1n],
    ),
  }
  expect(
    await confirmedOperationIds(ctx, 1n, receipt([log]), [op('activate', wallet, { selectionNonce: '5' })]),
  ).toEqual([op('activate').id])
  expect(
    await confirmedOperationIds(ctx, 1n, receipt([log]), [op('activate', wallet, { selectionNonce: '6' })]),
  ).toEqual([])
  for (const detail of [undefined, {}, { selectionNonce: null }])
    expect(await confirmedOperationIds(ctx, 1n, receipt([log]), [op('activate', wallet, detail)])).toEqual([])
})
it('same-reason rejections confirm only their exact violation, with complete prepared details', async () => {
  const reasonHash = sdk.hashText('same reason')
  const log = {
    address: ctx.stack.evaluator,
    topics: encodeEventTopics({
      abi: sdk.sidequestEvaluatorAbi,
      eventName: 'Rejected',
      args: { jobId: 1n, approver: wallet },
    }),
    data: encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes32' }], [1, reasonHash]),
  }
  const none = { ...op('reject', wallet, { reasonHash, violation: 'None' }), id: 'none' },
    quality = { ...op('reject', wallet, { reasonHash, violation: 'Quality' }), id: 'quality' }
  expect(
    await confirmedOperationIds(ctx, 1n, receipt([log]), [
      none,
      quality,
      op('reject', wallet, { reasonHash }),
      op('reject', mallory, { reasonHash, violation: 'Quality' }),
    ]),
  ).toEqual(['quality'])
})
it('rulings match both decision flags and the canonical v1 arbitrator', async () => {
  const reasonHash = sdk.hashText('decision')
  const fields = encodeAbiParameters(
    [{ type: 'bool' }, { type: 'bool' }, { type: 'bytes32' }],
    [true, false, reasonHash],
  )
  const log = {
    address: ctx.stack.evaluator,
    topics: encodeEventTopics({
      abi: sdk.sidequestEvaluatorAbi,
      eventName: 'Ruled',
      args: { jobId: 1n, arbitrator: wallet },
    }),
    data: fields,
  }
  const right = op('rule', wallet, { reasonHash, forWorker: true, slashLoser: false })
  const wrong = [
    op('rule', wallet, { reasonHash, forWorker: false, slashLoser: false }),
    op('rule', wallet, { reasonHash, forWorker: true, slashLoser: true }),
    op('rule', wallet, { reasonHash }),
    op('rule', mallory, { reasonHash, forWorker: true, slashLoser: false }),
  ]
  expect(await confirmedOperationIds(ctx, 1n, receipt([log]), [right, ...wrong])).toEqual([right.id])
})
it('the core submission event confirms only the recorded deliverable, regardless of reporter/sender', async () => {
  const deliverable = sdk.hashText('delivery')
  const log = {
    address: ctx.deployment.core,
    topics: encodeEventTopics({ abi: sdk.coreAbi, eventName: 'JobSubmitted', args: { jobId: 1n, provider: wallet } }),
    data: encodeAbiParameters([{ type: 'bytes32' }], [deliverable]),
  }
  expect(
    await confirmedOperationIds(ctx, 1n, receipt([log]), [op('submit', wallet, { deliverableHash: deliverable })]),
  ).toEqual([op('submit').id])
  expect(
    await confirmedOperationIds(ctx, 1n, receipt([log]), [
      op('submit', wallet, { deliverableHash: sdk.hashText('different') }),
    ]),
  ).toEqual([])
})
it('cancel is authorized by the canonical listing creator, and a settle event never confirms an accept', async () => {
  const abi = parseAbi(['event Cancelled(uint256 indexed jobId)'])
  expect(
    await confirmedOperationIds(
      ctx,
      1n,
      receipt([
        {
          address: ctx.stack.holding,
          data: '0x',
          topics: encodeEventTopics({ abi, eventName: 'Cancelled', args: { jobId: 1n } }),
        },
      ]),
      [op('cancel'), op('cancel', mallory)],
    ),
  ).toEqual([op('cancel').id])
  const settle = {
    address: ctx.stack.holding,
    topics: encodeEventTopics({
      abi: sdk.sidequestHoldingAbi,
      eventName: 'RewardSettled',
      args: { jobId: 1n, to: wallet },
    }),
    data: encodeAbiParameters([{ type: 'uint8' }, { type: 'uint256' }], [1, 7n]),
  }
  expect(await confirmedOperationIds(ctx, 1n, receipt([settle]), [op('accept')])).toEqual([])
})

const vault = `0x${'4'.repeat(40)}` as Address
const vaultCtx = {
  ...ctx,
  deployment: { ...ctx.deployment, sidequest: { vault, factory: ctx.stack.factory } },
} as sdk.Ctx
function vaultLog(
  kind: 'stake' | 'request-unstake' | 'cancel-unstake' | 'withdraw-stake',
  account = wallet,
  payer = wallet,
  amount = 7n,
  address = vault,
  shares = 7n,
  delegator = wallet,
) {
  if (kind === 'stake')
    return {
      address,
      topics: encodeEventTopics({
        abi: sdk.stakeVaultAbi,
        eventName: 'Delegated',
        args: { account, delegator, payer },
      }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [amount, shares]),
    }
  if (kind === 'request-unstake')
    return {
      address,
      topics: encodeEventTopics({
        abi: sdk.stakeVaultAbi,
        eventName: 'UndelegateRequested',
        args: { account, delegator },
      }),
      data: encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint48' }],
        [shares, amount, 10n, 1000],
      ),
    }
  if (kind === 'cancel-unstake')
    return {
      address,
      topics: encodeEventTopics({
        abi: sdk.stakeVaultAbi,
        eventName: 'UndelegateCancelled',
        args: { account, delegator },
      }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [shares, amount]),
    }
  return {
    address,
    topics: encodeEventTopics({ abi: sdk.stakeVaultAbi, eventName: 'Withdrawn', args: { account, delegator } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [shares, amount]),
  }
}
const vaultOp = (kind: string) =>
  op(kind, wallet, {
    vault,
    token: ctx.stack.factory,
    account: wallet,
    delegator: wallet,
    payer: wallet,
    amount: '7',
    shares: '7',
  })
it.each(['stake', 'request-unstake', 'cancel-unstake', 'withdraw-stake'] as const)(
  'vault %s matches ownership, method and configured vault despite floating asset quotes',
  (kind) => {
    const prepared = vaultOp(kind)
    expect(confirmsVaultOperation(vaultCtx, receipt([vaultLog(kind)]), prepared)).toBe(true)
    for (const log of [
      vaultLog(kind, mallory),
      vaultLog(kind, wallet, wallet, 7n, vault, 7n, mallory),
      vaultLog(kind, wallet, wallet, 7n, mallory),
      accepted(),
    ])
      expect(confirmsVaultOperation(vaultCtx, receipt([log]), prepared)).toBe(false)
    const changedAssets = vaultOperationResult(vaultCtx, receipt([vaultLog(kind, wallet, wallet, 1n)]), prepared)
    if (kind === 'stake') expect(changedAssets).toBeNull()
    else expect(changedAssets).toMatchObject({ shares: '7', assets: '1' })
    expect(confirmsVaultOperation(vaultCtx, receipt([vaultLog(kind, wallet, wallet, 7n, vault, 8n)]), prepared)).toBe(
      kind === 'stake',
    )
    expect(confirmsVaultOperation(vaultCtx, { ...receipt([vaultLog(kind)]), status: 'reverted' }, prepared)).toBe(false)
    expect(confirmsVaultOperation(vaultCtx, receipt([vaultLog(kind)]), { ...prepared, detail: null })).toBe(false)
  },
)
it('third-party delegateFor cannot confirm a wallet stake, and a replaced vault cannot confirm an old preparation', () => {
  expect(confirmsVaultOperation(vaultCtx, receipt([vaultLog('stake', wallet, mallory)]), vaultOp('stake'))).toBe(false)
  expect(
    confirmsVaultOperation(
      {
        ...vaultCtx,
        deployment: { ...vaultCtx.deployment, sidequest: { ...vaultCtx.deployment.sidequest!, vault: mallory } },
      },
      receipt([vaultLog('stake')]),
      vaultOp('stake'),
    ),
  ).toBe(false)
})
it('a saved wallet-operation hash survives a lost receipt response and polls the original without another preparation', async () => {
  const db = new DatabaseSync(':memory:'),
    sql = fromNodeSqlite(db)
  const hash = sdk.hashText('vault receipt')
  const getTransactionReceipt = vi
    .fn()
    .mockRejectedValueOnce(new Error('lost response'))
    .mockResolvedValue(receipt([vaultLog('stake')]))
  // SAFETY: only block timestamp is used for these operations; the remaining real client fields are preserved.
  const getBlock = vi
    .fn<sdk.Ctx['publicClient']['getBlock']>()
    .mockResolvedValue({ timestamp: 1000n } as Awaited<ReturnType<sdk.Ctx['publicClient']['getBlock']>>)
  // SAFETY: Vitest erases getBlock's generic block-tag signature; this fixture only queries mined blocks.
  const config = {
    network: 'monad-testnet' as const,
    contexts: {
      main: { ...vaultCtx, publicClient: { ...vaultCtx.publicClient, getTransactionReceipt, getBlock } } as sdk.Ctx,
    },
    domain: 'test',
    uri: 'https://test',
    manifestBaseUrl: '',
  }
  try {
    const board = new Board(sql, config),
      original = vaultOp('stake')
    sql.run(
      'INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?)',
      original.id,
      'vault:' + wallet,
      original.kind,
      original.actor,
      original.status,
      null,
      original.detail,
      0,
      0,
    )
    await expect(
      board.reportOperation({ address: wallet }, { operationId: original.id, txHash: hash }),
    ).rejects.toThrow('no receipt')
    expect(sql.all('SELECT status,tx_hash FROM operations')[0]).toEqual({ status: 'prepared', tx_hash: hash })
    const restarted = new Board(sql, config)
    expect(await restarted.reportOperation({ address: wallet }, { operationId: original.id })).toMatchObject({
      operationId: original.id,
      kind: 'stake',
      status: 'confirmed',
      txHash: hash,
      result: { shares: '7', assets: '7' },
    })
    expect(JSON.parse(sql.all<OperationRow>('SELECT * FROM operations')[0]!.detail!).result).toMatchObject({
      assets: '7',
      shares: '7',
    })
    expect(sql.all('SELECT * FROM operations')).toHaveLength(1)
    expect(
      await restarted.reportOperation(
        { address: wallet },
        { operationId: original.id, txHash: sdk.hashText('different') },
      ),
    ).toMatchObject({ txHash: hash, status: 'confirmed' })
    await expect(restarted.reportOperation({ address: mallory }, { operationId: original.id })).rejects.toThrow(
      'no wallet operation',
    )
    expect(getTransactionReceipt).toHaveBeenCalledTimes(2)
  } finally {
    db.close()
  }
})

it('VV2-002 confirms the A=6/S=10 request by its three exact shares, not its two-asset quote', () => {
  const operation = op('request-unstake', wallet, {
    vault,
    token: ctx.stack.factory,
    account: mallory,
    delegator: wallet,
    amount: '2',
    shares: '3',
  })
  expect(
    vaultOperationResult(vaultCtx, receipt([vaultLog('request-unstake', mallory, wallet, 1n, vault, 3n)]), operation),
  ).toMatchObject({ account: mallory, delegator: wallet, shares: '3', assets: '1' })
  expect(
    vaultOperationResult(vaultCtx, receipt([vaultLog('request-unstake', mallory, wallet, 1n, vault, 2n)]), operation),
  ).toBeNull()
})

function replayFixture(logs: object[], timestamp = 1000n) {
  const db = new DatabaseSync(':memory:'),
    sql = fromNodeSqlite(db)
  const r = receipt(logs),
    getTransactionReceipt = vi.fn(async () => r)
  // SAFETY: the matcher uses only timestamp from getBlock; all other chain context fields are retained.
  const getBlock = vi
    .fn<sdk.Ctx['publicClient']['getBlock']>()
    .mockResolvedValue({ timestamp } as Awaited<ReturnType<sdk.Ctx['publicClient']['getBlock']>>)
  // SAFETY: the matcher queries mined blocks only; the mock's erased generic block-tag signature is sufficient.
  const chain = { ...vaultCtx, publicClient: { ...vaultCtx.publicClient, getTransactionReceipt, getBlock } } as sdk.Ctx
  const config = {
    network: 'monad-testnet' as const,
    contexts: { main: chain },
    domain: 'test',
    uri: 'https://test',
    manifestBaseUrl: '',
  }
  const boot = () => new Board(sql, config),
    board = boot()
  const save = (operation: OperationRow) =>
    sql.run(
      'INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?)',
      operation.id,
      operation.task_id,
      operation.kind,
      operation.actor,
      operation.status,
      operation.tx_hash,
      operation.detail,
      operation.created_at,
      operation.updated_at,
    )
  const poll = (id: string, instance = board) =>
    instance.reportOperation({ address: wallet }, { operationId: id, txHash: r.transactionHash })
  return { db, sql, save, poll, r, boot, board, chain }
}

it.each(['stake', 'request-unstake', 'cancel-unstake', 'withdraw-stake'] as const)(
  'consumes one %s event once across concurrent operations and survives a restart',
  async (kind) => {
    const f = replayFixture([vaultLog(kind)])
    try {
      f.save({ ...vaultOp(kind), id: 'first' })
      f.save({ ...vaultOp(kind), id: 'second' })
      const results = await Promise.all([f.poll('first'), f.poll('second')])
      expect(results.filter((result) => result.status === 'confirmed')).toHaveLength(1)
      const winner = results.find((result) => result.status === 'confirmed')!,
        loser = results.find((result) => result.status === 'prepared')!
      expect(await f.poll(winner.operationId, f.boot())).toMatchObject(winner)
      expect(await f.poll(loser.operationId, f.boot())).toMatchObject({ status: 'prepared', result: null })
      expect(f.sql.all('SELECT * FROM operation_receipts')).toHaveLength(1)
    } finally {
      f.db.close()
    }
  },
)

it('distinct withdrawal logs in one transaction can confirm distinct operations', async () => {
  const f = replayFixture([vaultLog('withdraw-stake'), vaultLog('withdraw-stake')])
  try {
    for (const id of ['first', 'second', 'third']) f.save({ ...vaultOp('withdraw-stake'), id })
    expect(await f.poll('first')).toMatchObject({ status: 'confirmed' })
    expect(await f.poll('second')).toMatchObject({ status: 'confirmed' })
    expect(await f.poll('third')).toMatchObject({ status: 'prepared' })
    expect(f.sql.all('SELECT log_index FROM operation_receipts ORDER BY log_index')).toEqual([
      { log_index: 0 },
      { log_index: 1 },
    ])
  } finally {
    f.db.close()
  }
})

it.each(['stake', 'withdraw-stake'] as const)('refuses a %s receipt from a block before preparation', async (kind) => {
  const f = replayFixture([vaultLog(kind)], 999n)
  try {
    f.save({ ...vaultOp(kind), id: 'later', created_at: 1000 })
    await expect(f.poll('later')).rejects.toThrow('predates this operation')
    expect(f.sql.all('SELECT status FROM operations')).toEqual([{ status: 'prepared' }])
    expect(f.sql.all('SELECT * FROM operation_receipts')).toHaveLength(0)
  } finally {
    f.db.close()
  }
})

it('fails closed for previously confirmed receipts without a recorded log index', async () => {
  const f = replayFixture([vaultLog('withdraw-stake')])
  try {
    f.save({ ...vaultOp('withdraw-stake'), id: 'old', status: 'confirmed', tx_hash: f.r.transactionHash })
    f.save({ ...vaultOp('withdraw-stake'), id: 'new' })
    expect(await f.poll('new')).toMatchObject({ status: 'prepared' })
    expect(await f.poll('old')).toMatchObject({ status: 'confirmed' })
  } finally {
    f.db.close()
  }
})

it('rolls event ownership back when confirming the operation fails', () => {
  const f = replayFixture([vaultLog('withdraw-stake')])
  try {
    const operation = { ...vaultOp('withdraw-stake'), id: 'first' }
    f.save(operation)
    const failing: Sql = {
      ...f.sql,
      run: (query, ...bindings) => {
        if (query.startsWith('UPDATE operations')) throw new Error('write failed')
        f.sql.run(query, ...bindings)
      },
    }
    const event = {
      chainId: f.chain.deployment.chainId,
      hash: f.r.transactionHash,
      logIndex: 0,
      op: operation,
      now: 1000,
    }
    expect(() => confirmOperationEvent(failing, event)).toThrow('write failed')
    expect(f.sql.all('SELECT * FROM operation_receipts')).toHaveLength(0)
    expect(f.sql.all('SELECT status FROM operations')).toEqual([{ status: 'prepared' }])
    confirmOperationEvent(f.sql, event)
    expect(f.sql.all('SELECT status FROM operations')).toEqual([{ status: 'confirmed' }])
  } finally {
    f.db.close()
  }
})

function topUpLog() {
  return {
    address: ctx.stack.holding,
    topics: encodeEventTopics({
      abi: sdk.sidequestHoldingAbi,
      eventName: 'ToppedUp',
      args: { jobId: 1n, contributor: wallet },
    }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [7n, 7n]),
  }
}

it('a top-up event confirms only one matching task operation, and consumed events stay unavailable', async () => {
  const log = topUpLog()
  const first = { ...op('top-up', wallet, { amount: '7' }), id: 'first' },
    second = { ...first, id: 'second' }
  expect(await confirmedOperationIds(ctx, 1n, receipt([log]), [first, second])).toEqual(['first'])
  expect(await confirmedOperationIds(ctx, 1n, receipt([log, log]), [first, second])).toEqual(['first', 'second'])
  expect(await confirmedOperationEvents(ctx, 1n, receipt([log]), [second], new Set([0]))).toEqual([])
})

it.each([999n, 1000n])(
  'report_transaction binds top-up receipt events durably and excludes preparations after block %s',
  async (timestamp) => {
    const f = replayFixture([topUpLog()], timestamp)
    try {
      const terms: OfferTerms = {
        v: 2,
        taskId: 'task',
        projectId: null,
        policyVersion: null,
        mode: 'hire',
        title: 'Receipt fixture',
        brief: 'Unit test',
        acceptanceCriteria: [],
        deployment: {
          chainId: f.chain.deployment.chainId,
          core: f.chain.deployment.core,
          holding: f.chain.stack.holding,
          evaluator: f.chain.stack.evaluator,
          identity: f.chain.deployment.identity,
        },
        creator: wallet,
        approver: wallet,
        arbitrator: f.chain.deployment.arbitrator,
        token: f.chain.deployment.rewardTokens[0]!,
        reward: 7n,
        creatorBond: 0n,
        workerBond: 0n,
        deliveryDeadline: 100000,
        windows: { reviewSeconds: 3600, disputeSeconds: 3600, arbitrationSeconds: 43200 },
        eligibility: null,
        evidencePolicy: null,
        quote: null,
        salt: sdk.EMPTY_HASH,
      }
      f.sql.run(
        'INSERT INTO tasks (id,creator,stack,terms_json,terms_hash,job_id,from_block,created_at) VALUES (?,?,?,?,?,?,?,?)',
        'task',
        wallet,
        'main',
        canonicalJson(terms),
        termsHash(terms),
        '1',
        0,
        0,
      )
      for (const id of ['first', 'second']) f.save({ ...op('top-up', wallet, { amount: '7' }), id, created_at: 1000 })
      // SAFETY: this test exercises durable receipt reconciliation; the unrelated task projection is intentionally omitted.
      vi.spyOn(f.board, 'getTask').mockResolvedValue({} as Awaited<ReturnType<Board['getTask']>>)
      await f.board.reportTransaction({ address: wallet }, { taskId: 'task', txHash: f.r.transactionHash })
      await f.board.reportTransaction({ address: wallet }, { taskId: 'task', txHash: f.r.transactionHash })
      expect(f.sql.all("SELECT * FROM operations WHERE status='confirmed'")).toHaveLength(timestamp === 1000n ? 1 : 0)
      expect(f.sql.all('SELECT * FROM operation_receipts')).toHaveLength(timestamp === 1000n ? 1 : 0)
    } finally {
      f.db.close()
    }
  },
)
