import { expect, test } from 'vitest'
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import proposed from '../../../docs/p0-prod-artifact.json' with { type: 'json' }
import { validateProdConfig, type ProdArtifact } from '../src/prod-config.ts'

const configured = () => {
  const config = structuredClone(mainnet) as Parameters<typeof validateProdConfig>[0]
  const artifact = structuredClone(proposed) as ProdArtifact
  const fixtureAddress = '0x1111111111111111111111111111111111111111'
  config.deployment = {
    network: 'monad-mainnet', block: 123, core: fixtureAddress, factory: fixtureAddress,
    main: { kind: 'hireling-v1', factory: fixtureAddress, holding: fixtureAddress, evaluator: fixtureAddress, openTokens: true },
    hireling: { block: 123, factory: fixtureAddress, vault: fixtureAddress, feeSchedule: fixtureAddress, distributor: fixtureAddress, miningReserve: fixtureAddress, teamVesting: fixtureAddress, t0: 1_791_500_000 },
  }
  artifact.deployment = structuredClone({ main: config.deployment.main!, hireling: config.deployment.hireling! })
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

test.each(['factory', 'vault', 'feeSchedule', 'distributor', 'miningReserve', 'teamVesting'] as const)('every v1 component %s requires an explicit matching address', name => {
  const { config, artifact } = configured()
  config.deployment.hireling![name] = null
  expect(validateProdConfig(config, artifact)).toContain(`hireling:${name}`)
})

test.each([null, {}, { rpc: null }, { privy: { origins: 'bad' } }])('malformed artifact fails closed without echoing input', input => {
  expect(validateProdConfig(mainnet, input as unknown as ProdArtifact)).toEqual(['artifact structure'])
})
