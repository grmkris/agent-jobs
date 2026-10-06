import { describe, expect, it } from 'vitest'
import { clientSetup } from './ConnectionCard.tsx'

describe('MCP connection instructions', () => {
  const endpoint = 'https://dev.sidequest.exchange/mcp'

  it('gives each supported client an endpoint-specific setup', () => {
    expect(clientSetup('claude', endpoint)).toContain(`claude mcp add --transport http sidequest ${endpoint}`)
    expect(clientSetup('codex', endpoint)).toContain(`codex mcp add sidequest --url ${endpoint}`)
    expect(clientSetup('codex', endpoint)).toContain('codex mcp login sidequest')
    expect(clientSetup('grok', endpoint)).toContain(`grok mcp add --transport http sidequest ${endpoint}`)
    expect(clientSetup('grok', endpoint)).toContain('/mcps -> sidequest -> i')
    expect(JSON.parse(clientSetup('cursor', endpoint))).toEqual({ mcpServers: { sidequest: { url: endpoint } } })
  })
})
