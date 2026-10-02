import { expect, test } from 'vitest'
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import proposed from '../../../docs/p0-prod-artifact.json' with { type: 'json' }
import { RETIRED_ROLE_ADDRESSES, validateProdConfig, type ProdArtifact } from '../src/prod-config.ts'

const configured = () => {
  const config = structuredClone(mainnet) as Parameters<typeof validateProdConfig>[0]
  const artifact = structuredClone(proposed) as ProdArtifact
  const fixtureAddress = '0x1111111111111111111111111111111111111111'
  // Fresh R2 role keys (the shipped config still names the retired 1 Oct ones, LAUNCH-AUDIT-008).
  config.roles = { ...config.roles, relay: '0x8888888888888888888888888888888888888888', attester: '0x9999999999999999999999999999999999999999', arbitrator: '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa' }
  config.deployment = {
    network: 'monad-mainnet', block: 123, core: fixtureAddress, factory: fixtureAddress,
    main: { kind: 'hireling-v1', factory: fixtureAddress, holding: fixtureAddress, evaluator: fixtureAddress, openTokens: true },
    hireling: { block: 123, safe: fixtureAddress, factory: fixtureAddress, vault: fixtureAddress, feeSchedule: fixtureAddress, distributor: fixtureAddress, miningReserve: fixtureAddress, teamVesting: fixtureAddress, t0: 1_791_500_000 },
    rewardTokens: [mainnet.x402.usdc],
  }
  artifact.deployment = structuredClone({ main: config.deployment.main!, hireling: config.deployment.hireling!, rewardTokens: config.deployment.rewardTokens! })
  artifact.deployment.hireling.safeOwners = ['0x5555555555555555555555555555555555555555', '0x6666666666666666666666666666666666666666']
  artifact.deployment.hireling.safeThreshold = 1
  for (const [name, value] of Object.entries(config.roles)) artifact.addresses[name] = value
  for (const name of ['core', 'factory', 'holding', 'evaluator']) artifact.addresses[name] = fixtureAddress
  artifact.rpc.chainId = 143
  artifact.hyperSync.chainId = 143
  artifact.privy.appId = 'synthetic-approved-app'
  artifact.privy.approved = true
  return { config, artifact }
}

test('the real proposed recipe is correctly rejected before deployment and mapping approval', () => {
  expect(validateProdConfig(mainnet, proposed)).toEqual(expect.arrayContaining(['chain/providers', 'Privy app/origin approval', 'deployment network/block', 'open-token main Holding metadata', 'address:core']))
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
  expect(validateProdConfig(mainnet, input as unknown as ProdArtifact)).toEqual(['artifact structure'])
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

test('LAUNCH-AUDIT-003: the shipped artifact has the Safe policy fields, still unpinned', () => {
  expect(proposed.deployment.hireling).toMatchObject({ safeOwners: [], safeThreshold: null })
  expect(validateProdConfig(mainnet, proposed)).toContain('hireling:safeOwners/safeThreshold')
})

test('LAUNCH-AUDIT-004: the promoted reward list must hold USDC, and the artifact must pin the same list', () => {
  const cases: [string, (c: ReturnType<typeof configured>) => void, string][] = [
    ['no promoted list', c => { delete c.config.deployment.rewardTokens }, 'rewardTokens:USDC'],
    ['a list without USDC', c => { c.config.deployment.rewardTokens = ['0x7777777777777777777777777777777777777777']; c.artifact.deployment.rewardTokens = ['0x7777777777777777777777777777777777777777'] }, 'rewardTokens:USDC'],
    ['an artifact without the list', c => { delete c.artifact.deployment.rewardTokens }, 'artifact rewardTokens'],
    ['an artifact list that differs', c => { c.artifact.deployment.rewardTokens = [mainnet.x402.usdc, '0x7777777777777777777777777777777777777777'] }, 'artifact rewardTokens'],
  ]
  for (const [, mutate, label] of cases) {
    const c = configured()
    mutate(c)
    expect(validateProdConfig(c.config, c.artifact)).toEqual([label])
  }
  const c = configured()
  c.artifact.deployment.rewardTokens = [mainnet.x402.usdc.toLowerCase()]
  expect(validateProdConfig(c.config, c.artifact)).toEqual([])
  expect(validateProdConfig(mainnet, proposed)).toEqual(expect.arrayContaining(['rewardTokens:USDC']))
})

test('LAUNCH-AUDIT-008: the denylist is the shipped config\'s relay, attester and arbitrator; none may be a mainnet role', () => {
  expect([...RETIRED_ROLE_ADDRESSES].map(a => a.toLowerCase()).toSorted()).toEqual(
    [mainnet.roles.relay, mainnet.roles.attester, mainnet.roles.arbitrator].map(a => a.toLowerCase()).toSorted())
  expect(validateProdConfig(mainnet, proposed)).toEqual(expect.arrayContaining([
    'role:relay is a retired 1 Oct key', 'role:attester is a retired 1 Oct key', 'role:arbitrator is a retired 1 Oct key']))
  for (const role of ['relay', 'attester', 'arbitrator'] as const) {
    for (const old of RETIRED_ROLE_ADDRESSES) {
      const c = configured()
      c.config.roles[role] = old
      c.artifact.addresses[role] = old
      expect(validateProdConfig(c.config, c.artifact)).toEqual([`role:${role} is a retired 1 Oct key`, `address:${role} is a retired 1 Oct key`])
    }
  }
  const c = configured()
  c.artifact.addresses.holding = RETIRED_ROLE_ADDRESSES[0].toLowerCase()
  expect(validateProdConfig(c.config, c.artifact)).toEqual(expect.arrayContaining(['address:holding is a retired 1 Oct key']))
  expect(validateProdConfig(configured().config, configured().artifact)).toEqual([])
})
