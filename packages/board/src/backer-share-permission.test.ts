import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { decodeFunctionData, encodeFunctionData, erc20Abi, keccak256, stringToHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentExecutor } from './agent-executor.ts'
import { AgentLifecycle } from './agent-lifecycle.ts'
import { AgentPermissions } from './agent-permissions.ts'
import { AgentSigning } from './agent-signing.ts'
import { decodeGrantBatch } from './hire-batch.ts'
import { SponsorDesk, type NamedSponsorEntry } from './sponsor.ts'
import { fromNodeSqlite } from './store.ts'

const databases: DatabaseSync[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
})

async function fixture() {
  const context = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const operator = privateKeyToAccount(generatePrivateKey())
  const wallet = privateKeyToAccount(generatePrivateKey())
  const clock = { now: 1_791_000_000 }
  const chain = {
    count: new Map<string, bigint>(),
    disabled: new Set<string>(),
    spent: 0n,
    available: 100n,
    authorized: true,
  }
  const read = mockChainReads(context, chain)
  const submit = vi.fn(
    async (address: string, entries: readonly NamedSponsorEntry[], key: string, operationId?: string) => {
      recordCalls(address, operator.address, entries, chain)
      if (address.toLowerCase() === operator.address.toLowerCase() && entries.length > 0)
        recordSponsorSend(sql, address, key, clock.now)
      if (operationId !== undefined) {
        // The real SponsorDesk.submit refuses an agent operation that is not ready to send (sponsor.ts).
        const stage = sql.all<{ stage: string }>('SELECT stage FROM agent_operations WHERE id=?', operationId)[0]?.stage
        if (!['prepared', 'signed', 'approval'].includes(stage ?? ''))
          throw new Error('agent operation is not ready for this send')
        sql.run("UPDATE agent_operations SET stage='sending' WHERE id=?", operationId)
      }
      return {
        operationId: `0x${'ab'.repeat(32)}` as const,
        callsUsed: 1,
        status: 'confirmed' as const,
        txHash: `0x${'ab'.repeat(32)}` as const,
      }
    },
  )
  const sponsor = new SponsorDesk({
    sql,
    ctx: context,
    now: () => clock.now,
    fail: (_code, message) => new Error(message),
  })
  vi.spyOn(sponsor, 'ready').mockResolvedValue(undefined)
  vi.spyOn(sponsor, 'submit').mockImplementation(submit)
  const signing = new AgentSigning(
    sql,
    context,
    {
      signTypedData: async (_id, data) => wallet.signTypedData(JSON.parse(data)),
      signAuthorization: async () => {
        throw new Error('No upgrade')
      },
    },
    () => clock.now,
  )
  const permissions = new AgentPermissions({ sql, context, now: () => clock.now })
  const boot = () =>
    new AgentExecutor({
      sql,
      context,
      now: () => clock.now,
      sponsor,
      signing,
      prepareTool: async (request) => {
        if (request.tool !== 'request_permissions') throw new Error('No tenant preparation expected')
        // SAFETY: each fixture sends a typed ERC-7715 request; parse checks the envelope before persistence.
        return {
          request: permissions.parse(
            permissions.agents.get('agent'),
            request.args.permission as sdk.PermissionRequest,
            true,
          ),
        }
      },
      verifyToolSigning: async () => {
        throw new Error('No tool signature')
      },
    })
  const executor = boot()
  executor.agents.create({
    id: 'agent',
    operator: operator.address,
    privyUserId: 'did:privy:test',
    name: 'Scout',
    registry: context.deployment.identity,
    chainId: context.deployment.chainId,
  })
  executor.agents.bindWallet('agent', 'wallet', wallet.address)
  executor.agents.bindRegistry('agent', '42')
  for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const)
    executor.agents.advance('agent', state)
  await bootstrapGrants(permissions, operator, wallet, clock.now)
  const lifecycle = new AgentLifecycle({ sql, context, now: () => clock.now, sponsor })
  const share = (key: string, bps: number) =>
    boot().execute({ agentId: 'agent', boardId: 'public', operationKey: key, tool: 'set_backer_share', args: { bps } })
  const grant = async (key: string, terms: sdk.PermissionRequest['permission']) => {
    const result = await executor.execute({
      agentId: 'agent',
      boardId: 'public',
      operationKey: key,
      tool: 'request_permissions',
      args: {
        permission: {
          chainId: context.deployment.chainId,
          to: wallet.address,
          permission: terms,
          rules: [{ type: 'expiry', data: { timestamp: clock.now + 3600 } }],
        },
        standing: true,
      },
    })
    if (result.status !== 'approval') throw new Error('expected approval')
    const prepared = permissions.prepare(result.approval, operator.address)
    await permissions.decide(result.approval, operator.address, {
      approved: true,
      hash: prepared.hash,
      signature: await operator.signTypedData(JSON.parse(prepared.typedData)),
      standing: true,
    })
    return { prepared, request: JSON.parse(result.approval.request_json), agent: permissions.agents.get('agent') }
  }
  return { context, sql, executor, lifecycle, permissions, operator, wallet, chain, clock, share, grant, submit, read }
}

it('approves then resumes the same operation and redeems a second standing call without approval', async () => {
  const f = await fixture()
  const asked = await f.share('share-one', 5000)
  if (asked.status !== 'approval') throw new Error('expected approval')
  expect(JSON.parse(asked.approval.request_json)).toMatchObject({ standing: true })
  const prepared = f.permissions.prepare(asked.approval, f.operator.address, { calls: 2 })
  await f.permissions.decide(asked.approval, f.operator.address, {
    approved: true,
    hash: prepared.hash,
    signature: await f.operator.signTypedData(JSON.parse(prepared.typedData)),
    standing: true,
  })
  const first = await f.share('share-one', 5000)
  expect(first).toMatchObject({
    status: 'confirmed',
    result: { permissionId: prepared.hash, bps: 5000, agentId: '42' },
  })
  expect(await f.share('share-one', 5000)).toEqual(first)
  expect(f.submit).toHaveBeenCalledTimes(1)
  f.clock.now += 60
  expect(await f.share('share-two', 10000)).toMatchObject({
    status: 'confirmed',
    result: { permissionId: prepared.hash },
  })
  expect(f.submit).toHaveBeenCalledTimes(2)
  const entry = f.submit.mock.calls[1]![1][0]!
  // SAFETY: the sponsor received mapAgentCalls' validated hexadecimal redemption.
  const nested = decodeGrantBatch(entry.calls[0]!.data as Hex)[0]!
  expect(decodeFunctionData({ abi: sdk.identityAbi, data: nested.execution.callData }).args).toEqual([
    42n,
    sdk.BACKER_SHARE_KEY,
    sdk.encodeBackerShare(10000),
  ])
  expect(await f.share('share-spent', 1)).toMatchObject({ status: 'approval' })
})

it('refuses a different identity and operators without metadata authority before approval', async () => {
  const f = await fixture()
  f.chain.authorized = false
  await expect(f.share('unauthorized', 1)).rejects.toMatchObject({ reason: 'outside-policy' })
  await expect(
    f.executor.execute({
      agentId: 'agent',
      boardId: 'public',
      operationKey: 'other-id',
      tool: 'set_backer_share',
      args: { bps: 1, agentId: '43' },
    }),
  ).rejects.toMatchObject({ code: 'invalid' })
  expect(f.sql.all('SELECT * FROM approvals')).toHaveLength(0)
  expect(f.submit).not.toHaveBeenCalled()
})

it('covering skips exhausted LimitedCalls, disabled grants, and insufficient remaining allowances', async () => {
  const f = await fixture()
  const callData = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [f.wallet.address, 1n] })
  const exact = await f.grant('exact', {
    type: 'sidequest:contract-call',
    data: { target: f.context.deployment.factory, calldata: callData },
  })
  expect(await f.permissions.covering(exact.agent, exact.request)).toBeDefined()
  f.chain.count.set(exact.prepared.hash, 1n)
  expect(await f.permissions.covering(exact.agent, exact.request)).toBeUndefined()
  f.chain.count.clear()
  f.chain.disabled.add(exact.prepared.hash)
  expect(await f.permissions.covering(exact.agent, exact.request)).toBeUndefined()
  const allowance = await f.grant('allowance', {
    type: 'erc20-token-allowance',
    data: { tokenAddress: f.context.deployment.factory, allowanceAmount: '10', recipient: f.wallet.address },
  })
  f.chain.spent = 1n
  expect(await f.permissions.covering(allowance.agent, allowance.request)).toBeUndefined()
  f.chain.spent = 10n
  expect(await f.permissions.covering(allowance.agent, allowance.request)).toBeUndefined()
  const periodic = await f.grant('periodic', {
    type: 'erc20-token-periodic',
    data: {
      tokenAddress: f.context.deployment.factory,
      periodAmount: '10',
      periodDuration: 3600,
      recipient: f.wallet.address,
    },
  })
  f.chain.available = 9n
  expect(await f.permissions.covering(periodic.agent, periodic.request)).toBeUndefined()
})

it('disables only this agent’s permission with the operator grant and reconciles its original key', async () => {
  const f = await fixture()
  const granted = await f.grant('backer', {
    type: 'sidequest:backer-share',
    data: { registry: f.context.deployment.identity, agentId: '42' },
  })
  expect((await f.lifecycle.status('agent', f.operator.address)).permissions).toMatchObject([
    { permissionId: granted.prepared.hash },
  ])
  await f.lifecycle.disablePermission('agent', f.operator.address, granted.prepared.hash)
  expect(f.chain.disabled.has(granted.prepared.hash)).toBe(true)
  expect(f.permissions.list(granted.agent)).toMatchObject([{ status: 'disabled' }])
  await f.lifecycle.disablePermission('agent', f.operator.address, granted.prepared.hash)
  expect(f.submit.mock.calls[1]).toEqual([f.operator.address, [], f.submit.mock.calls[0]![2]])
  await expect(f.lifecycle.disablePermission('agent', f.wallet.address, granted.prepared.hash)).rejects.toThrow(
    /another operator/,
  )
  await expect(f.lifecycle.disablePermission('agent', f.operator.address, `0x${'01'.repeat(32)}`)).rejects.toThrow(
    /No such permission/,
  )
})

type ChainState = {
  count: Map<string, bigint>
  disabled: Set<string>
  spent: bigint
  available: bigint
  authorized: boolean
}

function mockChainReads(context: sdk.Ctx, chain: ChainState) {
  return vi.spyOn(context.publicClient, 'readContract').mockImplementation(async (request) => {
    const hash = String(request.args?.[request.functionName === 'disabledDelegations' ? 0 : 1])
    if (request.functionName === 'disabledDelegations') return chain.disabled.has(hash)
    if (request.functionName === 'callCounts') return chain.count.get(hash) ?? 0n
    if (request.functionName === 'spentMap') return chain.spent
    if (request.functionName === 'getAvailableAmount') return [chain.available, true, 0n]
    if (request.functionName === 'isAuthorizedOrOwner') return chain.authorized
    throw new Error(`Unexpected chain read ${request.functionName}`)
  })
}

function recordCalls(address: string, operator: string, entries: readonly NamedSponsorEntry[], chain: ChainState) {
  for (const call of entries.flatMap((entry) => entry.calls)) {
    // SAFETY: mapAgentCalls emits validated hex calldata; inspect only those frozen calls.
    const data = call.data as Hex
    if (address.toLowerCase() === operator.toLowerCase()) {
      const decoded = decodeFunctionData({ abi: sdk.delegationManagerAbi, data })
      if (decoded.functionName !== 'disableDelegation') throw new Error('expected disable')
      chain.disabled.add(sdk.delegationHash(decoded.args[0]))
      continue
    }
    for (const nested of decodeGrantBatch(data)) {
      const hash = sdk.delegationHash(nested.grant)
      chain.count.set(hash, (chain.count.get(hash) ?? 0n) + 1n)
    }
  }
}

function recordSponsorSend(sql: ReturnType<typeof fromNodeSqlite>, address: string, key: string, now: number) {
  const hash = keccak256(stringToHex(key))
  sql.run(
    `INSERT INTO sponsor_operations (id,wallet,delegation_hash,status,raw_tx,tx_hash,relay,nonce,reserved_cost,calls,baseline_calls,created_at,action_key,payload_hash)
     VALUES (?,?,'fixture','confirmed','0x',?,'fixture',0,'0',1,0,?,?,'fixture')`,
    hash,
    address.toLowerCase(),
    hash,
    now,
    key,
  )
}

async function bootstrapGrants(
  permissions: AgentPermissions,
  operator: ReturnType<typeof privateKeyToAccount>,
  wallet: ReturnType<typeof privateKeyToAccount>,
  now: number,
) {
  for (const kind of ['agent-work', 'agent-approve', 'agent-sweep', 'operator'] as const) {
    const base = {
      kind,
      delegator: kind === 'operator' ? operator.address : wallet.address,
      salt: BigInt(kind.length),
      start: now,
    }
    const prepared = permissions.grants.prepare(
      operator.address,
      kind === 'agent-sweep' ? { ...base, kind, operator: operator.address } : { ...base, kind },
    )
    await permissions.grants.confirm(
      prepared.hash,
      await (kind === 'operator' ? operator : wallet).signTypedData(JSON.parse(prepared.typedData)),
    )
  }
}
