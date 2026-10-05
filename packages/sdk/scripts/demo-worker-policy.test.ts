import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { flowJson, type FlowState } from '../src/flow-journal.ts'
import { demoPolicyBinding, migrateDemoPolicy, originalDemoBinding, reviewedCreators, type DemoBinding } from './demo-worker-policy.ts'

const original = '0xB9970A6371358F6C74DFb15A7cB2653E3AE3E471' as Address
const agent = '0x1111111111111111111111111111111111111111' as Address
const binding: DemoBinding = { chainId: 10143, factory: agent, vault: agent, core: agent, identity: agent,
  boardUrl: 'https://testnet.hireling.xyz', token: agent, repository: 'fixture/repo' }
const state: FlowState = {
  binding: originalDemoBinding(binding, original),
  values: { 'worker/entries': { taskId: 'frozen-task', phase: 'active' }, signature: 'saved-signature', amount: 12n },
  sends: { 'worker/activate': { raw: '0xab', hash: '0xcd', nonce: 12, wallet: agent } },
}

describe('explicit demo journal migration', () => {
  it('preserves pending sends, signatures, entries and intent values, then supports another reviewed addition', () => {
    const before = flowJson(state)
    const next = migrateDemoPolicy(state, binding, original, [original, agent], '2026-10-05')
    expect(next.binding).toBe(demoPolicyBinding(binding, [original, agent]))
    expect(next.sends).toEqual(state.sends)
    for (const [key, value] of Object.entries(state.values)) expect(next.values[key]).toEqual(value)
    expect(flowJson(state)).toBe(before)
    expect(migrateDemoPolicy(next, binding, original, [agent, original], 'later')).toBe(next)
    const later = migrateDemoPolicy(next, binding, original, [original, agent, '0x2222222222222222222222222222222222222222'], 'later')
    expect(later.values['policy/migrations']).toHaveLength(2)
    expect(later.sends).toEqual(state.sends)
  })

  it('refuses deployment drift, deletion of an approved creator and invalid or duplicate entries', () => {
    expect(() => migrateDemoPolicy(state, { ...binding, repository: 'other/repo' }, original, [original, agent], 'now')).toThrow('binding')
    expect(() => migrateDemoPolicy(state, binding, original, [agent], 'now')).toThrow('retain')
    for (const input of [[], ['not-an-address'], [original, original.toLowerCase()]]) expect(() => reviewedCreators(input)).toThrow()
  })
})
