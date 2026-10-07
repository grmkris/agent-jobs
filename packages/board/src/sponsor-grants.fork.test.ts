/** Named grants and durable reconstruction against real MetaMask bytecode and synchronous SQLite; no RPC test doubles. */
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Hex,
  type LocalAccount,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseTransaction,
  stringToHex,
} from 'viem'
import * as sdk from '@sidequest/sdk'
import { forkEnabled, forkSetupTimeout, startSidequestFork } from '../../sdk/test/sidequest-fixture.ts'
import { SponsorDesk, type NamedSponsorEntry } from './sponsor.ts'
import { GrantStore } from './grants.ts'
import { AgentStore } from './agents.ts'
import { BoardError } from './service.ts'
import { fromNodeSqlite } from './store.ts'
import { redeemGrantBatch } from './hire-batch.ts'

describe.skipIf(!forkEnabled)('named sponsorship grants on a real Monad fork', () => {
  let fixture: Awaited<ReturnType<typeof startSidequestFork>>
  let db: DatabaseSync
  let ctx: sdk.Ctx
  let grants: GrantStore
  let agents: AgentStore
  let work: Hex
  let sweep: Hex
  let secondWork: Hex
  let now: number
  const token = sdk.deployment('monad-testnet').rewardTokens[0]!
  const boot = () =>
    new SponsorDesk({
      sql: fromNodeSqlite(db),
      ctx,
      now: () => now,
      relay: { account: fixture.admin.account as LocalAccount, rpcUrl: fixture.url },
      fail: (code, message) => new BoardError(code, message),
    })
  const call = (nonce = 123456n) => ({
    to: ctx.stack.holding,
    data: encodeFunctionData({ abi: sdk.sidequestHoldingAbi, functionName: 'cancelSelection', args: [nonce] }),
  })

  async function confirm(wallet: sdk.Wallet, spec: sdk.GrantSpec): Promise<Hex> {
    const prepared = grants.prepare(fixture.creator.account.address, spec)
    await grants.confirm(prepared.hash, await sdk.signTypedDataJson(wallet, prepared.typedData))
    return prepared.hash
  }

  function bind(id: string, wallet: sdk.Wallet) {
    agents.create({
      id,
      operator: fixture.creator.account.address,
      privyUserId: 'did:privy:fork-fixture',
      name: id,
      registry: ctx.deployment.identity,
      chainId: ctx.deployment.chainId,
    })
    agents.bindWallet(id, `fixture-${id}`, wallet.account.address)
    for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const) agents.advance(id, state)
  }

  beforeAll(async () => {
    fixture = await startSidequestFork()
    ctx = { ...fixture.ctx, deployment: { ...fixture.ctx.deployment, relay: fixture.admin.account.address } }
    db = new DatabaseSync(':memory:')
    now = Number((await ctx.publicClient.getBlock()).timestamp)
    grants = new GrantStore(fromNodeSqlite(db), ctx)
    agents = new AgentStore(fromNodeSqlite(db), () => now)
    for (const wallet of [fixture.contributor, fixture.worker]) {
      const authorization = await wallet.signAuthorization({
        contractAddress: ctx.deployment.delegation.delegator,
        executor: fixture.admin.account.address,
      })
      const hash = await fixture.admin.sendTransaction({
        to: wallet.account.address,
        data: '0x',
        authorizationList: [authorization],
      })
      expect((await ctx.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success')
    }
    bind('agent-a', fixture.contributor)
    bind('agent-b', fixture.worker)
    work = await confirm(fixture.contributor, {
      kind: 'agent-work',
      delegator: fixture.contributor.account.address,
      salt: 10n,
      start: now,
    })
    sweep = await confirm(fixture.contributor, {
      kind: 'agent-sweep',
      delegator: fixture.contributor.account.address,
      operator: fixture.creator.account.address,
      salt: 11n,
      start: now,
    })
    secondWork = await confirm(fixture.worker, {
      kind: 'agent-work',
      delegator: fixture.worker.account.address,
      salt: 12n,
      start: now,
    })
    await fixture.send(
      token,
      [
        ...erc20Abi,
        {
          type: 'function',
          name: 'mint',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [],
          stateMutability: 'nonpayable',
        },
      ],
      'mint',
      [fixture.contributor.account.address, 100n],
    )
  }, forkSetupTimeout())
  afterAll(() => {
    db?.close()
    fixture?.close()
  })

  it('commits every grant reservation and the agent operation link before one confirmed batch', async () => {
    const entries: NamedSponsorEntry[] = [
      { grant: work, calls: [call()] },
      {
        grant: sweep,
        calls: [{ to: token, data: sdk.advanceExecution(token, fixture.creator.account.address, 10n).callData }],
      },
    ]
    const operation = agents.begin('agent-a', 'named-batch', 'public', 'sweep', {})
    agents.saveOperation(operation.id, 'prepared', { prepared: entries })
    const result = await boot().submit(fixture.contributor.account.address, entries, 'named-batch', operation.id)
    expect(result.status).toBe('confirmed')
    expect(agents.operation(operation.id)).toMatchObject({ stage: 'sending', sponsor_operation_id: result.operationId })
    expect(
      db
        .prepare('SELECT delegation_hash,calls FROM sponsor_entry_grants WHERE operation_id=? ORDER BY delegation_hash')
        .all(result.operationId),
    ).toEqual(
      [
        { delegation_hash: work, calls: 1 },
        { delegation_hash: sweep, calls: 1 },
      ].toSorted((a, b) => a.delegation_hash.localeCompare(b.delegation_hash)),
    )
    expect(await sdk.callsMade(ctx, work)).toBe(1n)
    expect(await sdk.callsMade(ctx, sweep)).toBe(1n)
    const nonce = await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })
    expect(await boot().submit(fixture.contributor.account.address, [], 'named-batch')).toEqual(result)
    expect(await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })).toBe(nonce)
  }, 120_000)

  it('rolls back the entire signed reservation if its agent operation cannot be linked', async () => {
    const operation = agents.begin('agent-a', 'link-fails', 'public', 'cancel-selection', {})
    const nonce = await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })
    await expect(
      boot().submit(
        fixture.contributor.account.address,
        [{ grant: work, calls: [call(123457n)] }],
        'link-fails',
        operation.id,
      ),
    ).rejects.toThrow('not ready')
    expect(db.prepare("SELECT id FROM sponsor_operations WHERE action_key='link-fails'").get()).toBeUndefined()
    expect(agents.operation(operation.id)).toMatchObject({ stage: 'intent', sponsor_operation_id: null })
    expect(await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })).toBe(nonce)
  }, 120_000)

  it('reconstructs a crash after persistence and broadcasts only its original signed bytes', async () => {
    const wallet = fixture.contributor.account.address
    const key = 'crash-before-broadcast'
    const id = keccak256(stringToHex(JSON.stringify([wallet.toLowerCase(), key])))
    const callValue = call(123458n)
    const data = redeemGrantBatch([
      { grant: grants.signed(work), execution: { target: callValue.to, callData: callValue.data, value: 0n } },
    ])
    const nonce = await ctx.publicClient.getTransactionCount({
      address: fixture.admin.account.address,
      blockTag: 'pending',
    })
    const gas = await sdk.transactionGas(
      ctx.publicClient,
      { account: fixture.admin.account, to: ctx.deployment.delegation.manager, data },
      600_000n,
    )
    const fees = await sdk.transactionFees(ctx.publicClient)
    const raw = await (fixture.admin.account as LocalAccount).signTransaction({
      type: 'eip1559',
      chainId: ctx.deployment.chainId,
      nonce,
      to: ctx.deployment.delegation.manager,
      data,
      gas,
      value: 0n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    })
    const hash = keccak256(raw)
    const baseline = Number(await sdk.callsMade(ctx, work))
    db.prepare(
      "INSERT INTO sponsor_operations (id,wallet,delegation_hash,status,raw_tx,tx_hash,relay,nonce,reserved_cost,calls,baseline_calls,created_at,action_key,payload_hash) VALUES (?,?,?,'pending',?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      wallet.toLowerCase(),
      work,
      raw,
      hash,
      fixture.admin.account.address,
      nonce,
      (gas * fees.maxFeePerGas).toString(),
      1,
      baseline,
      now,
      key,
      sdk.EMPTY_HASH,
    )
    db.prepare('INSERT INTO sponsor_entry_grants VALUES (?,?,?,?)').run(id, work, baseline, 1)
    const result = await boot().submit(wallet, [], key)
    expect(result).toMatchObject({ operationId: id, status: 'confirmed', txHash: hash })
    expect((await ctx.publicClient.getTransaction({ hash })).input).toBe(parseTransaction(raw).data)
    expect(await sdk.callsMade(ctx, work)).toBe(BigInt(baseline + 1))
    expect(await boot().submit(wallet, [], key)).toEqual(result)
  }, 120_000)

  it('keys rates by operator across agent wallets and validates recipient pins before sending', async () => {
    const before = await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })
    const wrongRecipient = sdk.advanceExecution(token, fixture.worker.account.address, 1n)
    await expect(
      boot().submit(
        fixture.contributor.account.address,
        [{ grant: sweep, calls: [{ to: token, data: wrongRecipient.callData }] }],
        'wrong-recipient',
      ),
    ).rejects.toThrow('recipient mismatch')
    db.prepare('INSERT INTO sponsor_operator_usage VALUES (?,?,?,?,?)').run(
      'fixture-rate-reservation',
      fixture.creator.account.address.toLowerCase(),
      20,
      0,
      now,
    )
    await expect(
      boot().submit(fixture.worker.account.address, [{ grant: secondWork, calls: [call()] }], 'second-agent-rate'),
    ).rejects.toMatchObject({ reason: 'rate' })
    expect(await ctx.publicClient.getTransactionCount({ address: fixture.admin.account.address })).toBe(before)
  }, 120_000)
})
