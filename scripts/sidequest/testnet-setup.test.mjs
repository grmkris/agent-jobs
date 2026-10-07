import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEther } from 'viem'
import { existingSafe, faucetPlan, parseSetupArgs, safeNonce, setupOperationId } from './testnet-setup-model.mjs'

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

const faucetConfig = {
  chainId: 10143,
  roles: { admin: '0x1111111111111111111111111111111111111111' },
  sidequest: { allocation: { ecosystem: '0x2222222222222222222222222222222222222222' } },
  deployment: {
    factory: '0x3333333333333333333333333333333333333333',
    rewardTokens: ['0x4444444444444444444444444444444444444444'],
  },
}

test('the faucet plan names its sender, constructor arguments, SIDE source and config key', () => {
  const plan = faucetPlan(faucetConfig, 'g1d')
  assert.equal(plan.sender, faucetConfig.roles.admin)
  assert.deepEqual(plan.constructorArgs, [
    faucetConfig.roles.admin,
    faucetConfig.deployment.factory,
    faucetConfig.deployment.rewardTokens,
    parseEther('1000').toString(),
    '1000000000',
  ])
  assert.equal(plan.funding.amount, '10000000 SIDE')
  assert.equal(plan.funding.amountWei, parseEther('10000000').toString())
  assert.equal(plan.funding.source, faucetConfig.sidequest.allocation.ecosystem)
  assert.equal(plan.configKey, 'deployment.testnetFaucet')
  assert.throws(() => faucetPlan({ ...faucetConfig, chainId: 143 }, 'g1d'), /testnet-only/)
})

test('faucet without send enabled prints the plan with no RPC, keys, artifact or journal', () => {
  const root = mkdtempSync(join(tmpdir(), 'g1d-faucet-plan-'))
  try {
    mkdirSync(join(root, 'contracts/config'), { recursive: true })
    writeFileSync(join(root, 'contracts/config/monad-testnet.json'), JSON.stringify(faucetConfig))
    const result = spawnSync(
      'bun',
      ['--no-env-file', new URL('./testnet-setup.mjs', import.meta.url).pathname, 'faucet', '--generation', 'g1d'],
      { cwd: root, env: { PATH: process.env.PATH } },
    )
    assert.equal(result.status, 0, result.stderr.toString())
    assert.deepEqual(JSON.parse(result.stdout.toString()), faucetPlan(faucetConfig, 'g1d'))
    assert.deepEqual(readdirSync(root), ['contracts'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
