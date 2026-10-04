import { describe, expect, it } from 'vitest'
import { CHILD_ENV_ALLOWLIST, childEnvironment } from './companion-process.ts'

describe('companion child environment boundary', () => {
  it('forwards only non-secret runtime settings and injects scoped identity', () => {
    const child = childEnvironment({
      PATH: '/bin', HOME: '/home/test', LANG: 'C', HIRELING_STATE: '/tmp/state', CLIPROXY_API_KEY: 'secret',
      PRIVY_APP_SECRET: 'secret', NODE_OPTIONS: '--inspect',
    }, 'agt_test', 'https://testnet.hireling.xyz')
    expect(child).toMatchObject({ PATH: '/bin', HOME: '/home/test', LANG: 'C', HIRELING_MANAGED_AGENT_ID: 'agt_test', HIRELING_API: 'https://testnet.hireling.xyz' })
    expect(child).not.toHaveProperty('HIRELING_STATE')
    expect(child).not.toHaveProperty('CLIPROXY_API_KEY')
    expect(child).not.toHaveProperty('PRIVY_APP_SECRET')
    expect(child).not.toHaveProperty('NODE_OPTIONS')
    expect(Object.keys(child).filter((key) => !CHILD_ENV_ALLOWLIST.includes(key as never))).toEqual(['HIRELING_MANAGED_AGENT_ID', 'HIRELING_API'])
  })
})
