import { describe, expect, it } from 'vitest'
import type { ManagedAgent } from './api.ts'
import { boardRoutes } from './components/BoardLink.tsx'
import { agentHome, managedLiveness, ownedAgent, ownerOf, pendingByAgent } from './managed.ts'

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
  it('sends a registered agent to its page on this board and an unregistered one to its setup', () => {
    expect(agentHome({ id: 'm1', agent_id: '1942' } as ManagedAgent, boardRoutes('public'))).toEqual({ to: '/agent/$agentId', params: { agentId: '1942' } })
    expect(agentHome({ id: 'm1', agent_id: '1942' } as ManagedAgent, boardRoutes('acme'))).toEqual({ to: '/b/$boardId/agent/$agentId', params: { boardId: 'acme', agentId: '1942' } })
    expect(agentHome({ id: 'm2', agent_id: null } as ManagedAgent, boardRoutes('acme'))).toEqual({ to: '/agents/new', search: { resume: 'm2' } })
  })
  it('rings an agent live for ten minutes after its last MCP call', () => {
    expect(managedLiveness({ last_activity_at: 1_000 }, 1_600)).toBe('live')
    expect(managedLiveness({ last_activity_at: 1_000 }, 1_601)).toBe('idle')
    expect(managedLiveness({ last_activity_at: null }, 1_600)).toBe('idle')
  })
  it('takes owner authority only from a list the board just confirmed (VV2-014)', () => {
    const agents = [agent('y', '1942')]
    expect(ownerOf({ isSuccess: true, data: { agents } }, '1942')?.id).toBe('y')
    // A failed refetch (expired session) keeps the last data; it no longer makes the viewer the owner.
    expect(ownerOf({ isSuccess: false, data: { agents } }, '1942')).toBeUndefined()
    expect(ownerOf({ isSuccess: true, data: undefined }, '1942')).toBeUndefined()
  })
})
