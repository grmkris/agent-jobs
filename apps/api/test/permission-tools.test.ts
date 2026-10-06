import { expect, it } from 'vitest'
import { PERMISSION_TOOLS, networkTool, permittedTool, requiredToolScope } from '../src/mcp-policy.ts'
import { agentTools } from '../src/tools-agents.ts'

it('permission tools read with the read scope, write with hire or work, and stay off mainnet until promotion', () => {
  expect([...PERMISSION_TOOLS].every(name => Object.hasOwn(agentTools, name))).toBe(true)
  expect(requiredToolScope('get_permissions')).toBe('hireling:read')
  expect(requiredToolScope('get_supported_permissions')).toBe('hireling:read')
  for (const name of ['request_permissions', 'use_permission', 'revoke_permission']) {
    expect(requiredToolScope(name)).toBe('write')
    expect(permittedTool({ scopes: ['hireling:read', 'hireling:work'] }, name)).toBe(true)
    expect(permittedTool({ scopes: ['hireling:read'] }, name)).toBe(false)
  }
  for (const name of PERMISSION_TOOLS) {
    expect(networkTool('monad-testnet', name)).toBe(true)
    expect(networkTool('monad-mainnet', name)).toBe(false)
  }
  expect(networkTool('monad-mainnet', 'create_task')).toBe(true)
})
