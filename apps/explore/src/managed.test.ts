import { describe, expect, it } from 'vitest'
import type { ManagedAgent } from './api.ts'
import { agentHome, ownedAgent, ownerOf, pendingByAgent } from './managed.ts'
import { initials } from './routes/MyAgents.tsx'

const agent = (id: string, agentId: string | null): ManagedAgent => ({ id, name: id, address: null, agent_id: agentId, state: 'active', last_activity_at: null, revoke_json: null }) as unknown as ManagedAgent

describe('managed agents', () => {
  it('counts only pending decisions, per agent', () => {
    const counts = pendingByAgent([
      { agent_id: 'a', status: 'pending' },
      { agent_id: 'a', status: 'pending' },
      { agent_id: 'a', status: 'approved' },
      { agent_id: 'b', status: 'rejected' },
      { agent_id: 'c', status: 'pending' },
    ])
    expect([...counts]).toEqual([
      ['a', 2],
      ['c', 1],
    ])
  })
  it('finds the operator’s agent behind a public number, never an unregistered one', () => {
    const agents = [agent('x', null), agent('y', '1942')]
    expect(ownedAgent(agents, '1942')?.id).toBe('y')
    expect(ownedAgent(agents, '1943')).toBeUndefined()
    expect(ownedAgent(undefined, '1942')).toBeUndefined()
  })
  it('sends a registered agent to its page and an unregistered one to its setup', () => {
    expect(agentHome({ id: 'm1', agent_id: '1942' } as ManagedAgent)).toEqual({ to: '/agent/$agentId', params: { agentId: '1942' } })
    expect(agentHome({ id: 'm2', agent_id: null } as ManagedAgent)).toEqual({ to: '/agents/new', search: { resume: 'm2' } })
  })
  it('draws an agent’s monogram from up to two initials', () => {
    expect(initials('My worker')).toBe('MW')
    expect(initials('  code   review bot ')).toBe('CR')
    expect(initials('')).toBe('')
  })
  it('takes owner authority only from a list the board just confirmed (VV2-014)', () => {
    const agents = [agent('y', '1942')]
    expect(ownerOf({ isSuccess: true, data: { agents } }, '1942')?.id).toBe('y')
    // A failed refetch (expired session) keeps the last data; it no longer makes the viewer the owner.
    expect(ownerOf({ isSuccess: false, data: { agents } }, '1942')).toBeUndefined()
    expect(ownerOf({ isSuccess: true, data: undefined }, '1942')).toBeUndefined()
  })
})
