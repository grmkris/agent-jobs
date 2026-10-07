import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existingSafe, parseSetupArgs, safeNonce, setupOperationId } from './testnet-setup-model.mjs'

test('a generation is required and all setup operation IDs change with it', () => {
  for (const args of [
    [],
    ['fund'],
    ['fund', '--generation'],
    ['fund', '--generation', '../g1d'],
    ['fund', '--generation', 'g1d', '--generation', 'g1d'],
  ])
    assert.throws(() => parseSetupArgs(args), /usage/u)
  assert.deepEqual(parseSetupArgs(['fund', '--generation', 'g1d']), { command: 'fund', generation: 'g1d' })
  for (const name of [
    'fund-deployer',
    'fund-relay',
    'reward-musd',
    'reward-meur',
    'faucet-deploy',
    'faucet-fund',
    'safe-create',
  ]) {
    assert.equal(setupOperationId(name, 'g1d'), `${name}-g1d`)
    assert.notEqual(setupOperationId(name, 'g1d'), setupOperationId(name, 'g1c'))
  }
  assert.notEqual(safeNonce('g1d'), safeNonce('g1c'))
  assert.equal(safeNonce('g1d'), safeNonce('g1d'))
})

test('the configured Safe is reused after the deployment config is reset', async () => {
  const safe = '0x1111111111111111111111111111111111111111'
  assert.equal(await existingSafe({ sidequest: { safe }, deployment: {} }, { getCode: async () => '0x6000' }), safe)
  assert.equal(await existingSafe({ deployment: { sidequest: { safe } } }, { getCode: async () => '0x6000' }), safe)
  await assert.rejects(existingSafe({ sidequest: { safe } }, { getCode: async () => undefined }), /no-code/u)
  assert.equal(
    await existingSafe(
      {},
      {
        getCode: async () => {
          throw new Error('unneeded read')
        },
      },
    ),
    null,
  )
})
