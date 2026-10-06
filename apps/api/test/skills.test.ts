import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ROLE_GUIDES, connectorInstructions } from '../src/mcp-instructions.ts'
import { requiredToolScope } from '../src/mcp-policy.ts'
import { tools } from '../src/tools.ts'
import { tenantTools } from '../src/tools-tenant.ts'
import { directoryTools } from '../src/directory.ts'
import { agentTools } from '../src/tools-agents.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8')
/** Named by a hosted skill but reached another way: build_activation is prepare_activation's internal continuation. */
const NOT_DIRECT_MCP = new Set(['build_activation'])

describe('skills are the single source for hosted MCP guidance', () => {
  it('keeps the generated module current with skill/', () => {
    expect(() => execFileSync('node', ['scripts/gen-skills.mjs', '--check'], { cwd: root, stdio: 'pipe' })).not.toThrow()
  })

  it('sends connector instructions under the 2,048 characters MCP clients keep', () => {
    for (const origin of ['https://dev.sidequest.exchange', 'https://sidequest.exchange']) {
      const text = connectorInstructions(origin)
      expect(text.length).toBeLessThanOrEqual(2048)
      expect(text).toContain(`${origin}/start.md`)
      expect(text).not.toContain('{{')
    }
  })

  it('serves each role SKILL.md body without front matter', () => {
    for (const role of ['connector', 'worker', 'publisher'] as const) {
      const body = read(`skill/${role}/SKILL.md`).replace(/^---\n[\s\S]*?\n---\n+/, '').trimEnd()
      expect(ROLE_GUIDES[role]).toBe(body)
      expect(ROLE_GUIDES[role].startsWith('# Sidequest ')).toBe(true)
    }
  })

  it('names only tools that hosted MCP exposes', () => {
    const registry = new Set(['get_instructions', ...Object.keys(tools), ...Object.keys(tenantTools), ...Object.keys(directoryTools), ...Object.keys(agentTools)])
    const files = ['skill/start.md', 'skill/connector/SKILL.md', 'skill/worker/SKILL.md', 'skill/publisher/SKILL.md', 'skill/connector/INSTRUCTIONS.md']
    const named = new Set(files.flatMap(file => [...read(file).matchAll(/`([a-z]+(?:_[a-z0-9]+)+)`/g)].map(match => match[1]!)))
    const unknown = [...named].filter(name => !registry.has(name))
    const hidden = [...named].filter(name => registry.has(name) && !NOT_DIRECT_MCP.has(name) && requiredToolScope(name) === undefined)
    expect({ unknown, hidden }).toEqual({ unknown: [], hidden: [] })
  })
})
