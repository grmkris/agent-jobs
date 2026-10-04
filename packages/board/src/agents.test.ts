import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AgentStore, canonicalAgentArgs } from './agents.ts'
import { fromNodeSqlite } from './store.ts'

describe('agent operation journal', () => {
  it('freezes action bytes and refuses a reused key for another action', () => {
    const db = new DatabaseSync(':memory:')
    const store = new AgentStore(fromNodeSqlite(db), () => 1_800_000_000)
    store.create({ id: 'agent-1', operator: '0x1111111111111111111111111111111111111111', privyUserId: 'did:privy:u', name: 'Test', registry: '0x2222222222222222222222222222222222222222', chainId: 10143 })
    const first = store.begin('agent-1', 'key-1', 'board', 'hire', { amount: 1, token: 'mUSD' })
    expect(store.begin('agent-1', 'key-1', 'board', 'hire', { amount: 1, token: 'mUSD' }).id).toBe(first.id)
    expect(() => store.begin('agent-1', 'key-1', 'board', 'hire', { amount: 2, token: 'mUSD' })).toThrow('different action')
    expect(store.saveOperation(first.id, 'prepared').stage).toBe('prepared')
    expect(() => store.saveOperation(first.id, 'confirmed')).toThrow('cannot move')
    expect(() => store.begin('missing', 'key-2', 'board', 'hire', {})).toThrow('Agent not found')
    expect(() => canonicalAgentArgs(new Date())).toThrow('plain JSON objects')
    db.close()
  })

  it('allows only durable forward transitions and retains terminal results across restart', () => {
    const db = new DatabaseSync(':memory:')
    const sql = fromNodeSqlite(db)
    const store = new AgentStore(sql, () => 1_800_000_000)
    store.create({ id: 'agent-2', operator: '0x1111111111111111111111111111111111111111', privyUserId: 'did:privy:u2', name: 'Test 2', registry: '0x2222222222222222222222222222222222222222', chainId: 10143 })
    const operation = store.begin('agent-2', 'key-2', 'board', 'status', { check: true })
    store.saveOperation(operation.id, 'prepared', { prepared: { to: '0x1' } })
    expect(() => store.saveOperation(operation.id, 'prepared', { prepared: { to: '0x2' } })).toThrow('cannot change')
    store.saveOperation(operation.id, 'signed', { signatures: { typed: '0xsig' } })
    expect(() => store.saveOperation(operation.id, 'signed', { signatures: {} })).toThrow('signature cannot change')
    store.saveOperation(operation.id, 'sending', { sponsorOperationId: 'relay-op' })
    store.saveOperation(operation.id, 'confirmed', { result: { txHash: '0xtx' } })
    expect(new AgentStore(sql, () => 1_800_000_001).operation(operation.id)).toMatchObject({ stage: 'confirmed', sponsor_operation_id: 'relay-op', result_json: '{"txHash":"0xtx"}' })
    expect(() => store.saveOperation(operation.id, 'sending')).toThrow('cannot move')
    expect(() => store.saveOperation(operation.id, 'confirmed', { result: { txHash: '0xchanged' } })).toThrow('result cannot change')
    db.close()
  })
})
