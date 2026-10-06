import { describe, expect, it } from 'vitest'
import { LIVE_WINDOW_SECONDS, agentStatus, orbGradient, orbPalette } from './agent-orb.ts'

describe('agent status', () => {
  const now = 1_800_000_000
  it('is working while a job is under way, whatever the presence', () => {
    expect(agentStatus({ working: true, heartbeat: 'stale', lastMcpCallAt: null, now })).toBe('working')
  })
  it('is live with a fresh heartbeat or an MCP call in the last ten minutes', () => {
    expect(agentStatus({ working: false, heartbeat: 'fresh', now })).toBe('live')
    expect(agentStatus({ working: false, lastMcpCallAt: now - LIVE_WINDOW_SECONDS, now })).toBe('live')
    expect(agentStatus({ working: false, heartbeat: 'unknown', lastMcpCallAt: now - 5, now })).toBe('live')
  })
  it('is idle otherwise, including a call from the future', () => {
    expect(agentStatus({ working: false, lastMcpCallAt: now - LIVE_WINDOW_SECONDS - 1, now })).toBe('idle')
    expect(agentStatus({ working: false, heartbeat: 'stale', now })).toBe('idle')
    expect(agentStatus({ working: false, lastMcpCallAt: now + 60, now })).toBe('idle')
    expect(agentStatus({ working: false, now })).toBe('idle')
  })
})

describe('orb palette', () => {
  it('is the same for an Agent ID every time and differs between IDs', () => {
    expect(orbPalette('2013')).toEqual(orbPalette('2013'))
    expect(orbPalette('2013')).not.toEqual(orbPalette('2014'))
    const hues = new Set(Array.from({ length: 50 }, (_, i) => orbPalette(String(1000 + i))[0]))
    expect(hues.size).toBeGreaterThan(40)
  })
  it('gives the shader four hsl colours and the CSS fallback the same ones', () => {
    const palette = orbPalette('7')
    expect(palette).toHaveLength(4)
    for (const colour of palette) expect(colour).toMatch(/^hsl\(\d{1,3}, \d{2}%, \d{2}%\)$/)
    const css = orbGradient(palette)
    for (const colour of palette) expect(css).toContain(colour)
  })
})
