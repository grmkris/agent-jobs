import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import {
  AgentStore,
  AgentPermissions,
  GrantStore,
  SponsorDesk,
  SPONSOR_OBJECT_NAME,
  fromNodeSqlite,
} from '@sidequest/board'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, expect, it, vi } from 'vitest'
import { runAgent } from '../src/agent-runtime.ts'
import type { BoardCall } from '../src/board.ts'

import * as oauth from '../src/oauth.ts'
const databases: DatabaseSync[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
})

async function fixture() {
  const context = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  vi.spyOn(sdk, 'context').mockReturnValue(context)
  vi.spyOn(context.publicClient, 'readContract').mockImplementation(async (request) => {
    if (request.functionName === 'disabledDelegations') return false
    if (request.functionName === 'callCounts') return 0n
    if (request.functionName === 'isAuthorizedOrOwner') return true
    throw new Error(`Unexpected chain read ${request.functionName}`)
  })
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const now = Math.floor(Date.now() / 1000)
  // One clock for the test and the runtime: the executor's 30-day expiry and the store's start must agree to the second.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now * 1000)
  const operator = privateKeyToAccount(generatePrivateKey())
  const wallet = privateKeyToAccount(generatePrivateKey())
  const agents = new AgentStore(sql, () => now)
  agents.create({
    id: 'scout',
    operator: operator.address,
    privyUserId: 'did:privy:fixture',
    name: 'Scout',
    registry: context.deployment.identity,
    chainId: 10143,
  })
  agents.bindWallet('scout', 'managed-wallet', wallet.address)
  agents.bindRegistry('scout', '42')
  for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const) agents.advance('scout', state)
  const grants = new GrantStore(sql, context)
  for (const kind of ['agent-work', 'agent-approve', 'agent-sweep'] as const) {
    const base = { delegator: wallet.address, salt: BigInt(kind.length), start: now }
    const prepared = grants.prepare(
      operator.address,
      kind === 'agent-sweep' ? { ...base, kind, operator: operator.address } : { ...base, kind },
    )
    await grants.confirm(prepared.hash, await wallet.signTypedData(JSON.parse(prepared.typedData)))
  }
  vi.spyOn(SponsorDesk.prototype, 'ready').mockResolvedValue(undefined)
  const submit = vi
    .spyOn(SponsorDesk.prototype, 'submit')
    .mockImplementation(async (_address, _entries, _key, operationId) => {
      if (operationId !== undefined) sql.run("UPDATE agent_operations SET stage='sending' WHERE id=?", operationId)
      return { operationId: `0x${'ab'.repeat(32)}`, callsUsed: 1, status: 'confirmed', txHash: `0x${'ab'.repeat(32)}` }
    })
  const resource = 'https://fixture.test/mcp'
  vi.spyOn(oauth, 'resolveOAuth').mockResolvedValue({
    owner: operator.address,
    address: wallet.address,
    chainId: 10143,
    scopes: ['sidequest:read', 'sidequest:work'],
    agentIds: ['scout'],
    registryAgentId: '42',
    clientId: 'fixture',
    resource,
  })
  const env: BoardCall['env'] = {
    network: 'monad-testnet',
    boardId: 'public',
    rpcUrl: 'http://127.0.0.1:1',
    domain: 'fixture.test',
    uri: 'https://fixture.test',
    manifestBaseUrl: 'https://fixture.test',
    screening: { baseUrl: '', apiKey: '', model: '' },
    attesterKey: '',
    relayKey: '',
    github: { appId: '', privateKeyPem: '', installationId: '' },
  }
  const tenant = {
    call: async () => {
      throw new Error('No board call or self-custody preparation for hosted shares')
    },
  }
  const bindings = {
    NETWORK: env.network,
    PRIVY_APP_ID: 'fixture',
    Board: { idFromName: (name: string) => ({ toString: () => name }), get: () => tenant },
  }
  const call = async (bps: number, operationKey = 'share-one') =>
    JSON.parse(
      await runAgent({
        req: {
          env,
          agentId: 'scout',
          tool: 'set_backer_share',
          args: { bps, operationKey },
          resource,
          bearer: 'fixture-connection',
        },
        bindings,
        sql,
        stateId: SPONSOR_OBJECT_NAME,
      }),
    )
  return { context, sql, operator, call, submit, permissions: new AgentPermissions({ sql, context, now: () => now }) }
}

it('a hosted connection receives an approval link then a confirmed redemption on the same key', async () => {
  const f = await fixture()
  const asked = await f.call(5000)
  expect(asked).toMatchObject({
    ok: true,
    result: {
      status: 'approval',
      approveUrl: expect.stringContaining('/agent/42?tab=approvals&approval='),
      approval: { kind: 'permission' },
    },
  })
  expect(f.submit).not.toHaveBeenCalled()
  const approval = f.permissions.agents.approval(asked.result.approval.id)
  const prepared = f.permissions.prepare(approval, f.operator.address)
  await f.permissions.decide(approval, f.operator.address, {
    approved: true,
    hash: prepared.hash,
    signature: await f.operator.signTypedData(JSON.parse(prepared.typedData)),
    standing: true,
  })
  const confirmed = await f.call(5000)
  expect(confirmed).toMatchObject({
    ok: true,
    result: {
      status: 'confirmed',
      result: { permissionId: prepared.hash, bps: 5000, agentId: '42', sponsorship: { status: 'confirmed' } },
    },
  })
  expect(await f.call(5000)).toEqual(confirmed)
  expect(f.submit).toHaveBeenCalledTimes(1)
  expect(await f.call(1, 'share-two')).toMatchObject({
    result: { status: 'confirmed', result: { permissionId: prepared.hash } },
  })
  expect(f.submit).toHaveBeenCalledTimes(2)
})
