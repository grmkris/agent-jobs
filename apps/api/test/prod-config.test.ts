import { expect, test } from 'vitest'
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }
import proposed from '../../../docs/p0-prod-artifact.json' with { type: 'json' }
import { validateProdConfig, type ProdArtifact } from '../src/prod-config.ts'

const configured = () => {
  const config = structuredClone(mainnet) as Parameters<typeof validateProdConfig>[0]
  const artifact = structuredClone(proposed) as ProdArtifact
  const fixtureAddress = '0x1111111111111111111111111111111111111111'
  config.deployment = { network: 'monad-mainnet', block: 123, core: fixtureAddress, factory: fixtureAddress, main: { holding: fixtureAddress, evaluator: fixtureAddress, openTokens: true } }
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

test.each(['stage', 'chain', 'RPC', 'HyperSync', 'Privy', 'secret', 'address', 'openTokens', 'legacy', 'faucet', 'remoteState'])('rejects %s inconsistency', kind => {
  const { config, artifact } = configured()
  if (kind === 'stage') artifact.stage = 'staging'
  if (kind === 'chain') artifact.chainId = 10143
  if (kind === 'RPC') artifact.rpc.url = 'https://testnet-rpc.monad.xyz'
  if (kind === 'HyperSync') artifact.hyperSync.url = 'https://monad-testnet.hypersync.xyz'
  if (kind === 'Privy') artifact.privy.origins = ['https://testnet.hireling.xyz']
  if (kind === 'secret') artifact.secretSources.RELAY_PRIVATE_KEY = 'RELAY_PRIVATE_KEY'
  if (kind === 'address') artifact.addresses.core = '0x0000000000000000000000000000000000000000'
  if (kind === 'openTokens') config.deployment.main!.openTokens = false
  if (kind === 'legacy') config.deployment.legacy = { old: { openTokens: true } }
  if (kind === 'faucet') config.factory.faucet = true
  if (kind === 'remoteState') artifact.remoteState = false
  expect(validateProdConfig(config, artifact).length).toBeGreaterThan(0)
})

test.each([null, {}, { rpc: null }, { privy: { origins: 'bad' } }])('malformed artifact fails closed without echoing input', input => {
  expect(validateProdConfig(mainnet, input as unknown as ProdArtifact)).toEqual(['artifact structure'])
})
