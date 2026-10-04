import { describe, expect, it } from 'vitest'
import { CHILD_ENV_ALLOWLIST, childEnvironment } from './companion-process.ts'

describe('companion child environment boundary', () => {
  it('AF-008 preserves Claude provider configuration while excluding wallet and launcher secrets', () => {
    const child = childEnvironment({
      PATH: '/bin', HOME: '/home/test', LANG: 'C', HIRELING_STATE: '/tmp/state', ANTHROPIC_BASE_URL: 'http://cliproxy', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_CUSTOM_HEADERS: 'x-secret', ANTHROPIC_API_KEY: 'secret', CLIPROXY_API_KEY: 'secret',
      PRIVY_APP_SECRET: 'secret', WORKER_PRIVATE_KEY: 'secret', ARBITRATOR_PRIVATE_KEY: 'secret', PRIVATE_KEY: 'secret', NODE_OPTIONS: '--inspect',
    }, 'agt_test', 'https://testnet.hireling.xyz')
    expect(child).toMatchObject({ PATH: '/bin', HOME: '/home/test', LANG: 'C', HIRELING_MANAGED_AGENT_ID: 'agt_test', HIRELING_API: 'https://testnet.hireling.xyz' })
    expect(child).not.toHaveProperty('HIRELING_STATE')
    expect(child).toMatchObject({ ANTHROPIC_BASE_URL: 'http://cliproxy', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_CUSTOM_HEADERS: 'x-secret', ANTHROPIC_API_KEY: 'secret', CLIPROXY_API_KEY: 'secret' })
    expect(child).not.toHaveProperty('PRIVY_APP_SECRET')
    for (const name of ['WORKER_PRIVATE_KEY', 'ARBITRATOR_PRIVATE_KEY', 'PRIVATE_KEY']) expect(child).not.toHaveProperty(name)
    expect(child).not.toHaveProperty('NODE_OPTIONS')
    expect(Object.keys(child).filter((key) => !CHILD_ENV_ALLOWLIST.includes(key as never))).toEqual(['HIRELING_MANAGED_AGENT_ID', 'HIRELING_API'])
  })
})
