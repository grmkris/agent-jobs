import { expect, test } from 'vitest'
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import proposed from '../../../docs/p0-prod-artifact.json' with { type: 'json' }
import { prodSecretSources, RETIRED_ROLE_ADDRESSES, validateProdConfig, type ChainConfig, type ProdArtifact } from '../src/prod-config.ts'

const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'

/** A complete, consistent mainnet record. Every field the validator reads is set here, so it holds whatever the shipped
 *  config and artifact contain (LAUNCH-AUDIT-FIX-002): only their shape is borrowed. */
const configured = () => {
  const config = structuredClone(mainnet) as unknown as ChainConfig
  const artifact = structuredClone(proposed) as ProdArtifact
  const fixtureAddress = '0x1111111111111111111111111111111111111111'
  const arbitrator = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa'
  Object.assign(config, {
    network: 'monad-mainnet', chainId: 143,
    roles: { admin: '0x7777777777777777777777777777777777777777', relay: '0x8888888888888888888888888888888888888888', attester: '0x9999999999999999999999999999999999999999', arbitrator },
    erc8004: { identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' },
    x402: { usdc: USDC }, factory: { faucet: false }, holdGates: { minHoldToPublish: 0, minHoldToClaim: 0 },
    faucetTokens: { names: [], symbols: [] }, knownTokens: [USDC], stacks: { names: ['main'] },
  })
  config.hireling = { ...config.hireling, defaultArbitrator: arbitrator }
  config.deployment = {
    network: 'monad-mainnet', block: 123, core: fixtureAddress, factory: fixtureAddress,
    main: { kind: 'hireling-v1', factory: fixtureAddress, holding: fixtureAddress, evaluator: fixtureAddress, openTokens: true },
    hireling: { block: 123, safe: fixtureAddress, factory: fixtureAddress, vault: fixtureAddress, feeSchedule: fixtureAddress, distributor: fixtureAddress, miningReserve: fixtureAddress, teamVesting: fixtureAddress, t0: 1_791_500_000 },
    rewardTokens: [USDC],
  }
  Object.assign(artifact, {
    stage: 'prod', network: 'monad-mainnet', chainId: 143,
    rpc: { url: 'https://rpc.monad.xyz', chainId: 143 }, hyperSync: { url: 'https://monad.hypersync.xyz', chainId: 143 },
    privy: { appId: 'synthetic-approved-app', origins: ['https://hireling.xyz'], approved: true },
    remoteState: true, admission: { drain: true }, explore: { mainnetLive: false }, secretSources: { ...prodSecretSources },
    addresses: { ...config.roles, identity: config.erc8004.identity, reputation: config.erc8004.reputation, usdc: USDC, core: fixtureAddress, factory: fixtureAddress, holding: fixtureAddress, evaluator: fixtureAddress },
  })
  artifact.deployment = structuredClone({ main: config.deployment.main!, hireling: config.deployment.hireling!, rewardTokens: config.deployment.rewardTokens! })
  artifact.deployment.hireling.safeOwners = ['0x5555555555555555555555555555555555555555', '0x6666666666666666666666666666666666666666']
  artifact.deployment.hireling.safeThreshold = 1
  return { config, artifact }
}

/** What the shipped pair may still lack before launch: R2's keys and Safe policy, the deploy and promotion, the Privy
 *  and provider approvals. A structural failure (stage, URLs, faucet, hold gates, known tokens, stacks, legacy pairs,
 *  secret sources, artifact structure) is never one of them. */
const PRE_LAUNCH = new Set(['chain/providers', 'Privy app/origin approval', 'deployment network/block', 'open-token main Holding metadata',
  'main v1 kind', 'v1 factory consistency', 'hireling block/T0', 'hireling:safeOwners/safeThreshold', 'rewardTokens:USDC',
  'artifact rewardTokens', 'hireling.defaultArbitrator is not roles.arbitrator', 'hireling.defaultArbitrator is a retired 1 Oct key'])
const preLaunch = (label: string) => PRE_LAUNCH.has(label) || /^(hireling|main|address):[A-Za-z]+$/.test(label) ||
  /^(role|address):[A-Za-z]+ is a retired 1 Oct key$/.test(label)

test('LAUNCH-AUDIT-FIX-002: the shipped config and artifact pass, or fail only on what launch still fills in', () => {
  expect(validateProdConfig(mainnet as unknown as ChainConfig, proposed as ProdArtifact).filter(label => !preLaunch(label))).toEqual([])
})

test('LAUNCH-AUDIT-FIX-002: a synthetic pre-R2 record (retired keys, unpinned Safe) refuses with exactly those labels', () => {
  const { config, artifact } = configured()
  const [relay, attester, arbitrator] = RETIRED_ROLE_ADDRESSES
  Object.assign(config.roles, { relay, attester, arbitrator })
  Object.assign(artifact.addresses, { relay, attester, arbitrator })
  config.hireling!.defaultArbitrator = arbitrator
  artifact.deployment.hireling.safeOwners = []
  artifact.deployment.hireling.safeThreshold = null
  const failures = validateProdConfig(config, artifact)
  expect(failures.toSorted()).toEqual([
    'hireling:safeOwners/safeThreshold', 'hireling.defaultArbitrator is a retired 1 Oct key',
    ...['relay', 'attester', 'arbitrator'].flatMap(name => [`role:${name} is a retired 1 Oct key`, `address:${name} is a retired 1 Oct key`]),
  ].toSorted())
  expect(failures.every(preLaunch)).toBe(true)
})

test('a consistent synthetic complete artifact passes structural validation only', () => {
  const { config, artifact } = configured()
  expect(validateProdConfig(config, artifact)).toEqual([])
})

test.each(['stage', 'chain', 'RPC', 'HyperSync', 'Privy', 'secret', 'address', 'openTokens', 'legacy', 'faucet', 'remoteState', 'mainKind', 'mainFactory', 'hirelingFactory', 'vault', 't0', 'hirelingBlock', 'stackNames'])('rejects %s inconsistency', kind => {
  const { config, artifact } = configured()
  if (kind === 'stage') artifact.stage = 'staging'
  if (kind === 'chain') artifact.chainId = 10143
  if (kind === 'RPC') artifact.rpc.url = 'https://testnet-rpc.monad.xyz'
  if (kind === 'HyperSync') artifact.hyperSync.url = 'https://monad-testnet.hypersync.xyz'
  if (kind === 'Privy') artifact.privy.origins = ['https://testnet.hireling.xyz']
  if (kind === 'secret') artifact.secretSources.RELAY_PRIVATE_KEY = 'RELAY_PRIVATE_KEY'
  if (kind === 'address') artifact.addresses.core = '0x0000000000000000000000000000000000000000'
  if (kind === 'openTokens') config.deployment.main!.openTokens = false
  if (kind === 'legacy') config.deployment.legacy = { old: { kind: 'legacy', factory: '0x2222222222222222222222222222222222222222', holding: '0x3333333333333333333333333333333333333333', evaluator: '0x4444444444444444444444444444444444444444', openTokens: true } }
  if (kind === 'faucet') config.factory.faucet = true
  if (kind === 'remoteState') artifact.remoteState = false
  if (kind === 'mainKind') config.deployment.main!.kind = 'legacy'
  if (kind === 'mainFactory') config.deployment.main!.factory = '0x2222222222222222222222222222222222222222'
  if (kind === 'hirelingFactory') config.deployment.hireling!.factory = '0x2222222222222222222222222222222222222222'
  if (kind === 'vault') artifact.deployment.hireling.vault = '0x0000000000000000000000000000000000000000'
  if (kind === 't0') config.deployment.hireling!.t0 = 0
  if (kind === 'hirelingBlock') artifact.deployment.hireling.block = 124
  if (kind === 'stackNames') config.stacks.names.push('demo')
  expect(validateProdConfig(config, artifact).length).toBeGreaterThan(0)
})

test.each(['safe', 'factory', 'vault', 'feeSchedule', 'distributor', 'miningReserve', 'teamVesting'] as const)('every v1 component %s requires an explicit matching address', name => {
  const { config, artifact } = configured()
  config.deployment.hireling![name] = null
  expect(validateProdConfig(config, artifact)).toContain(`hireling:${name}`)
})

test.each([null, {}, { rpc: null }, { privy: { origins: 'bad' } }])('malformed artifact fails closed without echoing input', input => {
  expect(validateProdConfig(configured().config, input as unknown as ProdArtifact)).toEqual(['artifact structure'])
})

test('D16 / PROD-GATE-001: the Safe must be recorded and match between config and artifact', () => {
  const { config, artifact } = configured()
  delete config.deployment.hireling!.safe
  expect(validateProdConfig(config, artifact)).toContain('hireling:safe')
  const other = configured()
  other.artifact.deployment.hireling.safe = '0x2222222222222222222222222222222222222222'
  expect(validateProdConfig(other.config, other.artifact)).toContain('hireling:safe')
})

test.each([
  ['unpinned owners', (h: ProdArtifact['deployment']['hireling']) => { delete h.safeOwners }],
  ['an empty owner set', (h: ProdArtifact['deployment']['hireling']) => { h.safeOwners = [] }],
  ['a duplicated owner', (h: ProdArtifact['deployment']['hireling']) => { h.safeOwners = ['0x5555555555555555555555555555555555555555', '0x5555555555555555555555555555555555555555'] }],
  ['a non-address owner', (h: ProdArtifact['deployment']['hireling']) => { h.safeOwners = ['0x5555555555555555555555555555555555555555', 'kris'] }],
  ['the zero address as owner', (h: ProdArtifact['deployment']['hireling']) => { h.safeOwners = ['0x0000000000000000000000000000000000000000'] }],
  ['an unpinned threshold', (h: ProdArtifact['deployment']['hireling']) => { h.safeThreshold = null }],
  ['threshold 0', (h: ProdArtifact['deployment']['hireling']) => { h.safeThreshold = 0 }],
  ['a threshold above the owner count', (h: ProdArtifact['deployment']['hireling']) => { h.safeThreshold = 3 }],
  ['a fractional threshold', (h: ProdArtifact['deployment']['hireling']) => { h.safeThreshold = 1.5 }],
] as const)('LAUNCH-AUDIT-003: the artifact must pin the Safe owners and threshold D16 reads back (%s refuses)', (_, mutate) => {
  const { config, artifact } = configured()
  mutate(artifact.deployment.hireling)
  expect(validateProdConfig(config, artifact)).toEqual(['hireling:safeOwners/safeThreshold'])
})

test('LAUNCH-AUDIT-004: the promoted reward list must hold USDC, and the artifact must pin the same list', () => {
  const cases: [string, (c: ReturnType<typeof configured>) => void, string][] = [
    ['no promoted list', c => { delete c.config.deployment.rewardTokens }, 'rewardTokens:USDC'],
    ['a list without USDC', c => { c.config.deployment.rewardTokens = ['0x7777777777777777777777777777777777777777']; c.artifact.deployment.rewardTokens = ['0x7777777777777777777777777777777777777777'] }, 'rewardTokens:USDC'],
    ['an artifact without the list', c => { delete c.artifact.deployment.rewardTokens }, 'artifact rewardTokens'],
    ['an artifact list that differs', c => { c.artifact.deployment.rewardTokens = [USDC, '0x7777777777777777777777777777777777777777'] }, 'artifact rewardTokens'],
  ]
  for (const [, mutate, label] of cases) {
    const c = configured()
    mutate(c)
    expect(validateProdConfig(c.config, c.artifact)).toEqual([label])
  }
  const c = configured()
  c.artifact.deployment.rewardTokens = [USDC.toLowerCase()]
  expect(validateProdConfig(c.config, c.artifact)).toEqual([])
})

test('LAUNCH-AUDIT-008: the denylist is three distinct addresses (the 1 Oct relay, attester and arbitrator); none may be a mainnet role', () => {
  expect(RETIRED_ROLE_ADDRESSES).toHaveLength(3)
  expect(RETIRED_ROLE_ADDRESSES.every(a => /^0x[0-9a-fA-F]{40}$/.test(a))).toBe(true)
  expect(new Set(RETIRED_ROLE_ADDRESSES.map(a => a.toLowerCase())).size).toBe(3)
  for (const role of ['relay', 'attester', 'arbitrator'] as const) {
    for (const old of RETIRED_ROLE_ADDRESSES) {
      const c = configured()
      c.config.roles[role] = old
      c.artifact.addresses[role] = old
      // The v1 default arbitrator follows roles.arbitrator (LAUNCH-AUDIT-FIX-001), so it goes stale with it.
      if (role === 'arbitrator') c.config.hireling!.defaultArbitrator = old
      expect(validateProdConfig(c.config, c.artifact)).toEqual([`role:${role} is a retired 1 Oct key`, `address:${role} is a retired 1 Oct key`,
        ...(role === 'arbitrator' ? ['hireling.defaultArbitrator is a retired 1 Oct key'] : [])])
    }
  }
  const c = configured()
  c.artifact.addresses.holding = RETIRED_ROLE_ADDRESSES[0].toLowerCase()
  expect(validateProdConfig(c.config, c.artifact)).toEqual(expect.arrayContaining(['address:holding is a retired 1 Oct key']))
  expect(validateProdConfig(configured().config, configured().artifact)).toEqual([])
})

test('LAUNCH-AUDIT-FIX-001: hireling.defaultArbitrator must be roles.arbitrator and no retired key', () => {
  const fresh = configured()
  fresh.config.hireling!.defaultArbitrator = fresh.config.roles.arbitrator!.toLowerCase()
  expect(validateProdConfig(fresh.config, fresh.artifact)).toEqual([])
  const notRole = 'hireling.defaultArbitrator is not roles.arbitrator'
  const stale = 'hireling.defaultArbitrator is a retired 1 Oct key'
  const cases: [string, string | null | undefined, string[]][] = [
    ['a fresh default that is not the role', '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB', [notRole]],
    ['no default', undefined, [notRole]],
    ['a null default', null, [notRole]],
    ['a non-address default', 'kris', [notRole]],
    ['the zero address', '0x0000000000000000000000000000000000000000', [notRole]],
    ...RETIRED_ROLE_ADDRESSES.map(old => [`retired ${old} beside a fresh role`, old, [notRole, stale]] as [string, string, string[]]),
  ]
  for (const [, value, labels] of cases) {
    const c = configured()
    if (value === undefined) delete c.config.hireling!.defaultArbitrator
    else c.config.hireling!.defaultArbitrator = value
    expect(validateProdConfig(c.config, c.artifact)).toEqual(labels)
  }
  const none = configured()
  none.config.hireling = null
  expect(validateProdConfig(none.config, none.artifact)).toEqual([notRole])
  // The role rotated nowhere: the default equals the role, and both are a retired key.
  for (const old of RETIRED_ROLE_ADDRESSES) {
    const c = configured()
    c.config.roles.arbitrator = old
    c.artifact.addresses.arbitrator = old
    c.config.hireling!.defaultArbitrator = old
    expect(validateProdConfig(c.config, c.artifact)).toEqual(['role:arbitrator is a retired 1 Oct key', 'address:arbitrator is a retired 1 Oct key', stale])
  }
})
