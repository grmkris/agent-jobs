/** Real SQLite, agent rows and signed grants; only the chain's grant counters are test doubles. */
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@sidequest/sdk'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentStore } from './agents.ts'
import { GrantStore } from './grants.ts'
import { hostedCreatorFacts } from './hosted-creators.ts'
import { fromNodeSqlite } from './store.ts'

const databases: DatabaseSync[] = []
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close() })

async function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const sql = fromNodeSqlite(db)
  const ctx = sdk.context('monad-testnet', 'main', 'http://127.0.0.1:1')
  const now = 1_800_000_000
  const [musd, meur] = ctx.deployment.rewardTokens as [`0x${string}`, `0x${string}`]
  const available = new Map<string, bigint>()
  const disabled = new Set<string>()
  vi.spyOn(ctx.publicClient, 'readContract').mockImplementation(async request => {
    const args = (request as { args?: readonly unknown[] }).args ?? []
    if (request.functionName === 'disabledDelegations') return disabled.has(String(args[0]))
    if (request.functionName === 'callCounts') return 0n
    if (request.functionName === 'getAvailableAmount') return [available.get(String(args[0])) ?? 0n, true, 0n]
    throw new Error(`Unexpected chain read: ${request.functionName}`)
  })
  const agents = new AgentStore(sql, () => now)
  const grants = new GrantStore(sql, ctx)
  const operator = privateKeyToAccount(generatePrivateKey())
  const hosted = async (id: string, agentId: string, state: 'active' | 'registered' = 'active') => {
    const wallet = privateKeyToAccount(generatePrivateKey())
    agents.create({ id, operator: operator.address, privyUserId: `did:privy:${id}`, name: id, registry: ctx.deployment.identity, chainId: ctx.deployment.chainId })
    agents.bindWallet(id, `${id}-wallet`, wallet.address)
    for (const s of ['upgraded', 'grants-live', 'registered', 'active'] as const) {
      agents.advance(id, s)
      if (s === 'registered') agents.bindRegistry(id, agentId)
      if (s === state) break
    }
    return wallet.address
  }
  const grant = async (agent: `0x${string}`, spec: { kind: 'allowance' | 'allowance-once'; token: `0x${string}`; amount: bigint; salt: bigint }, left: bigint) => {
    const prepared = grants.prepare(operator.address, { ...spec, delegator: operator.address, agent, start: now })
    await grants.confirm(prepared.hash, await operator.signTypedData(JSON.parse(prepared.typedData)))
    available.set(prepared.hash, left)
    return prepared.hash
  }
  return { sql, ctx, now, musd, meur, grants, hosted, grant, disabled }
}

it('names active hosted posters and reports the most one weekly grant can still fund, in that token only', async () => {
  const f = await fixture()
  const scout = await f.hosted('scout', '2029')
  const pending = await f.hosted('pending', '2031', 'registered')
  const stranger = privateKeyToAccount(generatePrivateKey()).address
  await f.grant(scout, { kind: 'allowance', token: f.musd, amount: 300n, salt: 1n }, 120n)
  await f.grant(scout, { kind: 'allowance', token: f.musd, amount: 500n, salt: 2n }, 450n)
  // Not what a hosted publish draws from: a one-off allowance, and a weekly grant in another token.
  await f.grant(scout, { kind: 'allowance-once', token: f.musd, amount: 900n, salt: 3n }, 900n)
  await f.grant(scout, { kind: 'allowance', token: f.meur, amount: 800n, salt: 4n }, 800n)
  const facts = await hostedCreatorFacts(f.sql, f.ctx, {
    addresses: [scout, pending, stranger],
    allowances: [{ address: scout, token: f.musd }, { address: stranger, token: f.musd }, { address: pending, token: f.musd }],
  }, f.now)
  expect(facts.agents).toEqual([{ address: scout, agentId: '2029' }])
  expect(facts.allowances).toEqual([{ address: scout, token: f.musd, available: '450' }])
})

it('a revoked or disabled grant funds nothing', async () => {
  const f = await fixture()
  const ledger = await f.hosted('ledger', '2030')
  const revoked = await f.grant(ledger, { kind: 'allowance', token: f.musd, amount: 300n, salt: 1n }, 300n)
  const disabled = await f.grant(ledger, { kind: 'allowance', token: f.musd, amount: 300n, salt: 2n }, 300n)
  f.grants.stop(revoked)
  f.disabled.add(disabled)
  const facts = await hostedCreatorFacts(f.sql, f.ctx, { addresses: [], allowances: [{ address: ledger, token: f.musd }] }, f.now)
  expect(facts.allowances).toEqual([{ address: ledger, token: f.musd, available: '0' }])
})
