import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AgentProfiles } from './agent-profiles.ts'
import { AgentStore } from './agents.ts'
import { fromNodeSqlite } from './store.ts'

const operator = '0x1111111111111111111111111111111111111111' as const
const registry = '0x2222222222222222222222222222222222222222' as const

function fixture() {
  const db = new DatabaseSync(':memory:')
  const sql = fromNodeSqlite(db)
  const agents = new AgentStore(sql, () => 1_800_000_000)
  agents.create({ id: 'one', operator, privyUserId: 'did:privy:one', name: 'Original', registry, chainId: 10143 })
  return { db, sql, agents, profiles: new AgentProfiles(sql, () => 1_800_000_001) }
}

describe('agent profiles', () => {
  it('reads defaults, updates bounded fields, and renames the agent', () => {
    const f = fixture()
    expect(f.profiles.read('one')).toMatchObject({ name: 'Original', description: '', tagline: '', generations: 0 })
    expect(
      f.profiles.update('one', { name: 'New name', description: 'A profile', tagline: 'Short' }, 'owner'),
    ).toMatchObject({
      name: 'New name',
      description: 'A profile',
      tagline: 'Short',
      updatedBy: 'owner',
    })
    expect(() => f.profiles.update('one', { name: 'x'.repeat(81) }, 'agent')).toThrow('name exceeds')
    expect(() => f.profiles.update('one', { description: 'x'.repeat(601) }, 'agent')).toThrow('description exceeds')
    expect(() => f.profiles.update('one', { tagline: 'x'.repeat(121) }, 'agent')).toThrow('tagline exceeds')
    expect(() => f.profiles.update('one', { name: '   ' }, 'agent')).toThrow('name exceeds')
    expect(f.agents.get('one').name).toBe('New name')
    f.db.close()
  })

  it('counts generations per UTC day and rejects the eleventh attempt', () => {
    const f = fixture()
    for (let i = 1; i <= 10; i++) expect(f.profiles.reserveGeneration('one', '2026-10-09')).toBe(i)
    expect(f.profiles.generationCount('one', '2026-10-09')).toBe(10)
    expect(() => f.profiles.reserveGeneration('one', '2026-10-09')).toThrow('limit')
    expect(new AgentProfiles(f.sql, () => 1_800_000_001).generationCount('one', '2026-10-09')).toBe(10)
    expect(f.profiles.update('one', { description: 'Changed' }, 'agent').generations).toBe(10)
    expect(f.profiles.reserveGeneration('one', '2026-10-10')).toBe(1)
    f.db.close()
  })

  it('caps creation and rename at 80 characters and rejects unknown profiles', () => {
    const f = fixture()
    expect(f.agents.rename('one', ` ${'x'.repeat(80)} `).name).toHaveLength(80)
    expect(() => f.agents.rename('one', 'x'.repeat(81))).toThrow('Invalid agent name')
    expect(() =>
      f.agents.create({
        id: 'two',
        operator,
        privyUserId: 'did:privy:two',
        name: 'x'.repeat(81),
        registry,
        chainId: 10143,
      }),
    ).toThrow('Invalid agent identity')
    expect(() => f.profiles.read('missing')).toThrow('Agent not found')
    expect(() => f.profiles.reserveGeneration('one', 'invalid')).toThrow('YYYY-MM-DD')
    f.db.close()
  })

  it('adds profiles to the existing version-2 schema without repeating its transition', () => {
    const f = fixture()
    f.db.exec('DROP TABLE agent_profiles')
    const profiles = new AgentProfiles(f.sql, () => 1_800_000_002)
    profiles.update('one', { description: 'Still here' }, 'owner')
    const restarted = new AgentProfiles(f.sql, () => 1_800_000_003)
    expect(restarted.read('one').description).toBe('Still here')
    expect(f.db.prepare("SELECT version FROM schema_versions WHERE name='agents'").get()).toEqual({ version: 2 })
    expect(f.agents.get('one').name).toBe('Original')
    f.db.close()
  })
})
