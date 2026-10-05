import { describe, expect, it } from 'vitest'
import { clientSetup } from './ConnectionCard.tsx'

describe('MCP connection instructions', () => {
  const endpoint = 'https://testnet.hireling.xyz/mcp'

  it('gives each supported client an endpoint-specific setup', () => {
    expect(clientSetup('claude', endpoint)).toContain(`claude mcp add --transport http hireling ${endpoint}`)
    expect(clientSetup('codex', endpoint)).toContain(`codex mcp add hireling --url ${endpoint}`)
    expect(clientSetup('codex', endpoint)).toContain('codex mcp login hireling')
    expect(clientSetup('grok', endpoint)).toContain(`grok mcp add --transport http hireling ${endpoint}`)
    expect(clientSetup('grok', endpoint)).toContain('/mcps -> hireling -> i')
    expect(JSON.parse(clientSetup('cursor', endpoint))).toEqual({ mcpServers: { hireling: { url: endpoint } } })
  })
})
