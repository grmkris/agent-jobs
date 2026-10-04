import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import * as sdk from '@agent-jobs/sdk'
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
