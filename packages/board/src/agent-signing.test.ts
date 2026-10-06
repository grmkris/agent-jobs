import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import * as sdk from '@sidequest/sdk'
import { privateKeyToAccount } from 'viem/accounts'
import { AgentSigning } from './agent-signing.ts'
import { AgentStore } from './agents.ts'
import { fromNodeSqlite } from './store.ts'
import { assertAgentEnvelope, assertExactAgentTypedData, type AgentTypedData } from './agent-signing-scope.ts'
import { finishAgentSignRequest, prepareAgentSignRequest } from './agent-signing-store.ts'

const deployment = sdk.deployment('monad-testnet')
const context = { deployment, stack: sdk.stack(deployment, 'main') }
const agent = '0x1111111111111111111111111111111111111111'
const worker = '0x2222222222222222222222222222222222222222'
const selection = sdk.typedDataJson(sdk.holdingDomain(deployment.chainId, context.stack.holding), sdk.selectionTypes, 'Selection', {
  jobId: 7n, worker, agentId: 12n, termsHash: sdk.EMPTY_HASH, activateBy: 1_800_000_100, nonce: 3n,
})

function mutate(change: (value: AgentTypedData) => void): string {
  const value = JSON.parse(selection)
  change(value)
  return JSON.stringify(value)
}

describe('routine signer boundaries', () => {
  it('permits the creator to select another registered worker', () => {
    expect(assertAgentEnvelope(context, selection, agent).message.worker).toBe(worker)
  })

  it.each([
    (value: AgentTypedData) => { value.domain.chainId = 143 },
    (value: AgentTypedData) => { value.domain.verifyingContract = agent },
    (value: AgentTypedData) => { value.domain.salt = sdk.EMPTY_HASH },
    (value: AgentTypedData) => { value.types.Selection![0]!.type = 'uint72' },
    (value: AgentTypedData) => { value.types.Extra = [] },
    (value: AgentTypedData) => { value.message.jobId = '-1' },
    (value: AgentTypedData) => { value.message.activateBy = String(1n << 48n) },
    (value: AgentTypedData) => { value.message.extra = 1 },
  ])('refuses changed chain, domain, type or message fields', change => {
    expect(() => assertAgentEnvelope(context, mutate(change), agent)).toThrow()
  })

  it.each(['worker', 'jobId', 'agentId', 'termsHash', 'activateBy', 'nonce'])('refuses a changed frozen %s', field => {
    const changed = mutate(value => { value.message[field] = field === 'worker' ? agent : field === 'termsHash' ? `0x${'00'.repeat(32)}` : '99' })
    expect(() => assertExactAgentTypedData(changed, selection)).toThrow('frozen authorized action')
  })

  it('pins authorizations and wallet consent to the bound agent', () => {
    const budget = sdk.typedDataJson(sdk.coreDomain(deployment.chainId, deployment.core), sdk.setBudgetTypes, 'SetBudgetAuthorization', {
      signer: agent, jobId: 7n, token: deployment.rewardTokens[0], amount: 3n, optParamsHash: sdk.EMPTY_HASH, nonce: 1n, deadline: 1_800_000_100n,
    })
    expect(() => assertAgentEnvelope(context, budget, worker)).toThrow('signer')
    const consent = sdk.agentWalletTypedData(deployment, { agentId: 12n, owner: worker, newWallet: agent, deadline: 1_800_000_100n })
    expect(() => assertAgentEnvelope(context, consent, worker)).toThrow('Consent wallet')
  })
})

const json = (r: sdk.DirectoryEnvelope) => sdk.directoryTypedDataJson(r)
const changed = (r: sdk.DirectoryEnvelope, change: (value: AgentTypedData) => void) => {
  const value = JSON.parse(json(r))
  change(value)
  return JSON.stringify(value)
}

describe('directory records an agent signs for its own listing', () => {
  const audience = 'https://dev.sidequest.exchange'
  const bound = { agentId: '2013', audience }
  const record = (kind: sdk.DirectoryKind, payload: Record<string, unknown>, seconds = 300): sdk.DirectoryEnvelope => ({
    version: 1, kind, chainId: deployment.chainId, identityRegistry: deployment.identity, audience, agentId: '2013', wallet: agent,
    generation: 1, nonce: 1, issuedAt: 1_800_000_000, expiresAt: 1_800_000_000 + seconds, payload,
  })
  const enrollment = record('Enrollment', { profile: { name: 'Reviewer', description: '', services: [] }, delegate: '0x0000000000000000000000000000000000000000', adDelegate: false, grantExpiresAt: 0, enrolled: true })
  const ad = record('ServiceAd', { serviceId: 'review' }, 86_400)
  const takeDown = record('RevokeAd', { serviceId: 'review' })

  it('permits an enrollment, an ad and a take-down that name this agent, registry and directory', () => {
    for (const r of [enrollment, ad, takeDown]) expect(assertAgentEnvelope(context, json(r), agent, bound).primaryType).toBe(r.kind)
  })

  it('refuses a heartbeat, and a record without the bound agent and directory', () => {
    expect(() => assertAgentEnvelope(context, json(record('Heartbeat', {}, 60)), agent, bound)).toThrow('Heartbeats')
    expect(() => assertAgentEnvelope(context, json(enrollment), agent)).toThrow('bound agent and audience')
  })

  it.each([
    ['another directory', (r: sdk.DirectoryEnvelope) => json({ ...r, audience: 'https://sidequest.exchange' })],
    ['the presence domain for an ad', (r: sdk.DirectoryEnvelope) => changed(r, (v) => { v.domain.name = 'SidequestPresence' })],
    ['another chain', (r: sdk.DirectoryEnvelope) => json({ ...r, chainId: 143 })],
    ['a verifying contract', (r: sdk.DirectoryEnvelope) => changed(r, (v) => { v.domain.verifyingContract = agent })],
    ['a domain without its salt', (r: sdk.DirectoryEnvelope) => changed(r, (v) => { delete v.domain.salt })],
    ['an extra type', (r: sdk.DirectoryEnvelope) => changed(r, (v) => { v.types.Extra = [] })],
    ['an extra message field', (r: sdk.DirectoryEnvelope) => changed(r, (v) => { v.message.extra = '1' })],
    ['another wallet', (r: sdk.DirectoryEnvelope) => json({ ...r, wallet: worker })],
    ['another agent', (r: sdk.DirectoryEnvelope) => json({ ...r, agentId: '2014' })],
    ['another registry', (r: sdk.DirectoryEnvelope) => json({ ...r, identityRegistry: worker })],
    ['another version', (r: sdk.DirectoryEnvelope) => changed(r, (v) => { v.message.version = '2' })],
    ['an ad longer than a day', (r: sdk.DirectoryEnvelope) => json({ ...r, expiresAt: r.issuedAt + 86_401 })],
    ['an expiry before issue', (r: sdk.DirectoryEnvelope) => json({ ...r, expiresAt: r.issuedAt })],
  ] as const)('refuses %s', (_, change) => {
    expect(() => assertAgentEnvelope(context, change(ad), agent, bound)).toThrow()
  })

  it('signs a record once through the journal, only as the board prepared it', async () => {
    const key = privateKeyToAccount(`0x${'42'.repeat(32)}`)
    const sql = fromNodeSqlite(new DatabaseSync(':memory:'))
    const agents = new AgentStore(sql, () => 1_800_000_000)
    agents.create({ id: 'lister', operator: worker, privyUserId: 'did:privy:lister', name: 'Lister', registry: deployment.identity, chainId: deployment.chainId })
    agents.bindWallet('lister', 'lister-wallet', key.address)
    agents.bindRegistry('lister', '2013')
    let calls = 0
    const signing = new AgentSigning(sql, { ...context, publicClient: {} } as unknown as sdk.Ctx, {
      signTypedData: async (_wallet, typedData) => { calls++; return key.signTypedData(JSON.parse(typedData)) },
      signAuthorization: async () => { throw new Error('unused') },
    }, () => 1_800_000_000)
    const mine = { ...ad, wallet: key.address }
    const signature = await signing.signDirectory('lister', mine, audience, async () => mine)
    expect(await signing.signDirectory('lister', mine, audience, async () => mine)).toBe(signature)
    expect(calls).toBe(1)
    const next = { ...mine, nonce: 2 }
    await expect(signing.signDirectory('lister', next, audience, async () => ({ ...next, payload: { serviceId: 'other' } }))).rejects.toThrow('frozen authorized action')
    await expect(signing.signDirectory('lister', { ...next, wallet: worker }, audience, async () => next)).rejects.toThrow('not this agent')
    expect(calls).toBe(1)
  })

  it('keeps an enrollment and a take-down to five minutes', () => {
    for (const r of [enrollment, takeDown]) expect(() => assertAgentEnvelope(context, json({ ...r, expiresAt: r.issuedAt + 301 }), agent, bound)).toThrow('window')
  })
})

describe('signer request and continuation journals on real SQLite', () => {
  it('recovers the same request key after crashes before and after the provider result', () => {
    const db = new DatabaseSync(':memory:')
    const sql = fromNodeSqlite(db)
    const agents = new AgentStore(sql, () => 1_800_000_000)
    agents.create({ id: 'signing-fixture', operator: worker, privyUserId: 'did:privy:fixture', name: 'Fixture', registry: deployment.identity, chainId: deployment.chainId })
    agents.bindWallet('signing-fixture', 'fixture-wallet', agent)
    const operation = agents.begin('signing-fixture', 'action-1', 'public', 'select_worker', { taskId: 'task' })
    const input = { agentId: 'signing-fixture', walletId: 'fixture-wallet', purpose: `tool:${operation.id}`, request: { typedData: selection }, now: 1_800_000_000 }
    const first = prepareAgentSignRequest(sql, input)
    expect(first.result_json).toBeNull()
    expect(prepareAgentSignRequest(fromNodeSqlite(db), input).id).toBe(first.id)
    expect(() => prepareAgentSignRequest(sql, { ...input, request: { typedData: '{}' } })).toThrow('cannot change')
    expect(() => prepareAgentSignRequest(sql, { ...input, walletId: 'other-wallet' })).toThrow('cannot change')
    finishAgentSignRequest(sql, first, '0xfixture-signature')
    expect(prepareAgentSignRequest(fromNodeSqlite(db), input).result_json).toBe('"0xfixture-signature"')
    expect(() => finishAgentSignRequest(sql, first, '0xchanged')).toThrow('different signature')
    agents.freezeStep(operation.id, 'continuation', { transactions: [{ data: '0xfrozen' }] })
    expect(new AgentStore(fromNodeSqlite(db), () => 1_800_000_001).step(operation.id, 'continuation')).toEqual({ transactions: [{ data: '0xfrozen' }] })
    expect(() => agents.freezeStep(operation.id, 'continuation', { transactions: [] })).toThrow('cannot change')
    db.close()
  })
})
