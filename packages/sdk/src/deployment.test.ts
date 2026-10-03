import { describe, expect, it } from 'vitest'
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import testnet from './fixtures/legacy-deployment.json' with { type: 'json' }
import { type DeploymentConfig, NotDeployedError, PRODUCTION_CLOCKS, allStacks, deployment, deploymentFromConfig, stackByHolding } from './deployment.ts'

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const currentConfig = () => structuredClone(testnet) as DeploymentConfig
const v1Config = () => {
  const config = currentConfig()
  const d = config.deployment
  d.legacy = { ...d.legacy, 'main-v3': { ...d.main!, kind: 'legacy', factory: d.factory! }, 'demo-v2': { ...d.demo!, kind: 'legacy', factory: d.factory! } }
  for (const pair of Object.values(d.legacy)) { pair.kind = 'legacy'; pair.factory = d.factory! }
  delete d.demo
  delete d.fast
  d.factory = address(1)
  d.main = { kind: 'hireling-v1', factory: address(1), holding: address(2), evaluator: address(3), openTokens: true }
  d.hireling = { block: 77_000_000, safe: address(9), factory: address(1), vault: address(4), feeSchedule: address(5), distributor: address(6), miningReserve: address(7), teamVesting: address(8), t0: 1_791_500_000 }
  return config
}

describe('deployment config compatibility', () => {
  it('the archived pre-v1 testnet config keeps all pairs and defaults missing kind/factory to legacy', () => {
    const d = deploymentFromConfig('monad-testnet', currentConfig())
    expect(d.hireling).toBeNull()
    expect(allStacks(d).length).toBe(Object.keys(testnet.deployment.legacy).length + 2)
    for (const [, s] of allStacks(d)) {
      expect(s.kind).toBe('legacy')
      expect(s.factory).toBe(testnet.deployment.factory)
    }
    expect(d.stacks.main?.openTokens).toBe(true)
    expect(d.legacyStacks['main-v1']?.openTokens).toBe(false)
  })

  it('a v1 deployment keeps the old FACTORY and old holding for already-published jobs', () => {
    const config = v1Config()
    const d = deploymentFromConfig('monad-testnet', config)
    expect(Object.keys(d.stacks)).toEqual(['main'])
    expect(d.stacks.main).toMatchObject({ kind: 'hireling-v1', factory: address(1) })
    expect(d.hireling).toEqual({ ...config.deployment.hireling, block: 77_000_000n })
    const old = stackByHolding(d, testnet.deployment.main.holding.toUpperCase())
    expect(old?.[0]).toBe('main-v3')
    expect(old?.[1]).toMatchObject({ kind: 'legacy', factory: testnet.deployment.factory, openTokens: true })
    expect(d.legacyStacks['demo-v2']?.factory).toBe(testnet.deployment.factory)
    expect(d.legacyStacks['main-v1']?.factory).toBe(testnet.deployment.factory)
  })

  it('an explicit old FACTORY survives migration to a new top-level FACTORY', () => {
    const config = v1Config()
    for (const s of Object.values(config.deployment.legacy!)) s.factory = testnet.deployment.factory
    const d = deploymentFromConfig('monad-testnet', config)
    expect(Object.values(d.legacyStacks).every(s => s.factory === testnet.deployment.factory)).toBe(true)
    expect(stackByHolding(d, address(99))).toBeUndefined()
  })

  it('loads optional deploy-time clocks while preserving older deployment records', () => {
    const c = v1Config()
    expect(deploymentFromConfig('monad-testnet', c).hireling?.clocks).toBeUndefined()
    c.deployment.hireling!.clocks = { ...PRODUCTION_CLOCKS, minReviewWindow: 120, epochDuration: 3600 }
    expect(deploymentFromConfig('monad-testnet', c).hireling?.clocks).toEqual({ ...PRODUCTION_CLOCKS, minReviewWindow: 120, epochDuration: 3600 })
    c.deployment.hireling!.clocks = { ...PRODUCTION_CLOCKS, epochDuration: 599 }
    expect(() => deploymentFromConfig('monad-testnet', c)).toThrow('epochDuration')
    c.deployment.hireling!.clocks = { ...PRODUCTION_CLOCKS, minReviewWindow: 120 }
    c.network = 'monad-mainnet'; c.chainId = 143
    expect(() => deploymentFromConfig('monad-mainnet', c)).toThrow('Mainnet requires production clock')
  })

  it('a synthetic unpromoted mainnet record reports unavailable independently of the shipped config', () => {
    const c: DeploymentConfig = { ...mainnet, deployment: {} }
    expect(() => deploymentFromConfig('monad-mainnet', c)).toThrow(NotDeployedError)
  })

  it('the checked-in deployment exposes a kind and FACTORY for every recorded pair', () => {
    const d = deployment('monad-testnet')
    for (const [, s] of allStacks(d)) {
      expect(['legacy', 'hireling-v1']).toContain(s.kind)
      expect(s.factory).toMatch(/^0x[0-9a-fA-F]{40}$/)
    }
  })

  it('parses the shipped testnet record and follows the shipped mainnet promotion state', () => {
    expect(Object.keys(deployment('monad-testnet').stacks)).toContain('main')
    if (Object.keys(mainnet.deployment).length === 0) {
      expect(() => deployment('monad-mainnet')).toThrow(NotDeployedError)
    } else {
      expect(deployment('monad-mainnet').stacks.main?.kind).toBe('hireling-v1')
    }
  })

  it('treats null optional stacks as absent', () => {
    const c = v1Config()
    c.deployment.demo = null
    c.deployment.fast = null
    expect(Object.keys(deploymentFromConfig('monad-testnet', c).stacks)).toEqual(['main'])
  })

  it.each([
    (c: DeploymentConfig) => { delete c.deployment.main!.kind },
    (c: DeploymentConfig) => { c.deployment.main!.kind = 'legacy' },
    (c: DeploymentConfig) => { delete c.deployment.legacy!['main-v1']!.kind },
    (c: DeploymentConfig) => { delete c.deployment.legacy!['main-v1']!.factory },
    (c: DeploymentConfig) => { c.deployment.demo = { ...c.deployment.legacy!['demo-v2']! }; delete c.deployment.demo.kind },
    (c: DeploymentConfig) => { c.deployment.fast = { ...c.deployment.legacy!['demo-v2']! }; delete c.deployment.fast.factory },
    (c: DeploymentConfig) => { delete c.deployment.main!.factory },
    (c: DeploymentConfig) => { delete c.deployment.hireling },
    (c: DeploymentConfig) => { c.deployment.main!.factory = address(99) },
    (c: DeploymentConfig) => { c.deployment.hireling!.vault = address(0) },
    (c: DeploymentConfig) => { c.deployment.hireling!.safe = address(0) },
    (c: DeploymentConfig) => { c.deployment.hireling!.t0 = 0 },
    (c: DeploymentConfig) => { c.deployment.hireling!.block = 0.5 },
    (c: DeploymentConfig) => { c.deployment.main!.kind = 'unknown' as never },
    (c: DeploymentConfig) => { c.network = 'monad-mainnet' },
  ])('refuses incomplete or inconsistent v1 metadata', mutate => {
    const c = v1Config()
    mutate(c)
    expect(() => deploymentFromConfig('monad-testnet', c)).toThrow()
  })
})
