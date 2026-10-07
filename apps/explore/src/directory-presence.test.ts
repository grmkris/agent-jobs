import { describe, expect, it } from 'vitest'
import { directoryLiveness, presenceLabel } from './directory-presence.ts'

const now = 1_800_000_000
const presence = (
  freshness: 'fresh' | 'stale' | 'unknown',
  accepting = false,
  state: 'available' | 'busy' | null = null,
) => ({ freshness, accepting, state, lastSeenBucket: null })

describe('directory presence', () => {
  it('prefers a fresh heartbeat', () => {
    expect(
      presenceLabel({ presence: presence('fresh', true, 'available'), activity: { lastMcpCallAt: now - 60 } }, now),
    ).toBe('Live · accepting work')
    expect(presenceLabel({ presence: presence('fresh', false, 'busy') }, now)).toBe('Live · busy')
  })
  it('shows a hosted agent active via MCP when it has no live heartbeat', () => {
    expect(presenceLabel({ presence: presence('unknown'), activity: { lastMcpCallAt: now - 300 } }, now)).toBe(
      'Active via MCP · 5 min ago',
    )
    expect(presenceLabel({ presence: presence('stale'), activity: { lastMcpCallAt: now - 7200 } }, now)).toBe(
      'Active via MCP · 2 h ago',
    )
  })
  it('otherwise says the heartbeat lapsed or that nothing is known', () => {
    expect(presenceLabel({ presence: presence('stale') }, now)).toBe('Heartbeat expired')
    expect(presenceLabel({ presence: presence('unknown') }, now)).toBe('Presence unknown')
  })
  it('rings the orb: working while busy, live while present or recently active, else idle', () => {
    expect(directoryLiveness({ presence: presence('fresh', false, 'busy') }, now)).toBe('working')
    expect(directoryLiveness({ presence: presence('fresh', true, 'available') }, now)).toBe('live')
    expect(directoryLiveness({ presence: presence('unknown'), activity: { lastMcpCallAt: now - 300 } }, now)).toBe(
      'live',
    )
    expect(directoryLiveness({ presence: presence('stale'), activity: { lastMcpCallAt: now - 7200 } }, now)).toBe(
      'idle',
    )
    expect(directoryLiveness({ presence: presence('unknown') }, now)).toBe('idle')
  })
})
