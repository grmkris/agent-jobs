/** An agent's look and liveness, as pure functions: the orb's palette, its CSS stand-in and the live/working state. */

export type AgentLiveness = 'live' | 'working' | 'idle'

/** How long after its last MCP call an agent still counts as live. */
export const LIVE_WINDOW_SECONDS = 600

/**
 * Working while a job of its is under way; live with a fresh heartbeat or an MCP call in the last ten minutes;
 * otherwise idle. Liveness is activity, never a promise to take work.
 */
export function agentStatus(input: {
  working: boolean
  heartbeat?: 'fresh' | 'stale' | 'unknown'
  lastMcpCallAt?: number | null
  now: number
}): AgentLiveness {
  if (input.working) return 'working'
  if (input.heartbeat === 'fresh') return 'live'
  const last = input.lastMcpCallAt
  return last != null && input.now - last >= 0 && input.now - last <= LIVE_WINDOW_SECONDS ? 'live' : 'idle'
}

/** FNV-1a over the Agent ID, so one agent always gets the same colours on every page and device. */
function fnv(text: string): number {
  let hash = 0x811c9dc5
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193)
  return hash >>> 0
}

/** Four colours around one hue picked by the Agent ID: the shader's palette and the CSS fallback's, identical. */
export function orbPalette(agentId: string): [string, string, string, string] {
  const seed = fnv(agentId)
  const hue = seed % 360
  const turn = 28 + ((seed >>> 9) % 24)
  return [
    `hsl(${hue}, 72%, 56%)`,
    `hsl(${(hue + turn) % 360}, 78%, 64%)`,
    `hsl(${(hue + 2 * turn) % 360}, 70%, 46%)`,
    `hsl(${(hue + 180 + turn) % 360}, 60%, 70%)`,
  ]
}

/** The orb without WebGL: the same palette as a soft radial gradient. */
export function orbGradient([a, b, c, d]: readonly string[]): string {
  return `radial-gradient(circle at 30% 28%, ${d} 0%, transparent 42%), radial-gradient(circle at 72% 70%, ${c} 0%, transparent 55%), linear-gradient(135deg, ${a}, ${b})`
}
