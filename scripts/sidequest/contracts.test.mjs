import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { archivePath, candidatePath, parseArgs, planAction, resetConfig, roleFor } from './contracts-model.mjs'

const admin = '0xe5B7054e177e833D63f8d0548ffa9ecfC4289A71'
const promoted = {
  chainId: 10143,
  roles: { admin, relay: '0x1', attester: '0x2', arbitrator: '0x3' },
  usdPegged: ['0xmusd'],
  boards: ['https://dev.sidequest.exchange', 'https://sidequest.exchange'],
  sidequest: { safe: '0xsafe' },
  deployment: {
    block: 1,
    core: '0xcore',
    factory: '0xside',
    sidequest: { holding: '0xh' },
    rewardTokens: ['0xmusd', '0xmeur'],
    testnetFaucet: '0xf',
  },
}
const fresh = resetConfig(promoted)
const env = { MONAD_RPC_URL: 'https://rpc.invalid', SIDEQUEST_TESTNET_SEND: '1' }
const deployer = { address: admin, path: '/k/deployer.json', passwordPath: '/k/deployer.password' }
const owner = {
  address: '0xd3392156861c922675d4859BB9C32d8ad2BaD956',
  path: '/k/safe_owner.json',
  passwordPath: '/k/safe_owner.password',
}

test('every action needs an explicit generation label', () => {
  assert.throws(() => parseArgs(['deploy']), /generation-required/)
  assert.throws(() => parseArgs(['deploy', '--generation', 'G1D']), /generation-required/)
  assert.throws(() => parseArgs(['launch', '--generation', 'g1d']), /invalid-contract-action/)
  assert.deepEqual(parseArgs(['deploy', '--generation', 'g1d']), { action: 'deploy', generation: 'g1d' })
  assert.equal(candidatePath('g1d'), 'contracts/broadcast/sidequest-g1d/sidequest/monad-testnet.candidate.json')
  assert.equal(archivePath('g1d'), 'contracts/config/archive/pre-g1d-monad-testnet.json')
})

test('archive keeps every top-level key and only the reward tokens of the old deployment', () => {
  assert.deepEqual(Object.keys(fresh), Object.keys(promoted))
  assert.deepEqual(fresh.deployment, { rewardTokens: ['0xmusd', '0xmeur'] })
  assert.deepEqual(fresh.boards, promoted.boards)
  assert.throws(() => resetConfig(fresh), /config-not-promoted-nothing-to-archive/)
  assert.throws(() => resetConfig({ ...promoted, chainId: 143 }), /fresh-testnet-config-required/)
})

test('sending actions refuse without SIDEQUEST_TESTNET_SEND and plans never broadcast', () => {
  const unsent = { MONAD_RPC_URL: env.MONAD_RPC_URL }
  assert.throws(
    () =>
      planAction({
        action: 'deploy',
        generation: 'g1d',
        config: fresh,
        env: unsent,
        candidateExists: false,
        signer: deployer,
      }),
    /testnet-send-not-enabled/,
  )
  assert.throws(
    () =>
      planAction({
        action: 'accept',
        generation: 'g1d',
        config: promoted,
        env: unsent,
        candidateExists: true,
        signer: owner,
      }),
    /testnet-send-not-enabled/,
  )
  const plan = planAction({
    action: 'deploy-plan',
    generation: 'g1d',
    config: fresh,
    env: unsent,
    candidateExists: false,
    signer: deployer,
  })
  assert.equal(plan.sends, false)
  assert.ok(!plan.args.includes('--broadcast'))
  assert.equal(plan.forgeEnv.FOUNDRY_BROADCAST, 'broadcast/sidequest-g1d')
})

test('deploy refuses a promoted config, an existing candidate and a foreign deployer', () => {
  assert.throws(
    () =>
      planAction({
        action: 'deploy',
        generation: 'g1d',
        config: promoted,
        env,
        candidateExists: false,
        signer: deployer,
      }),
    /deployment-already-started/,
  )
  assert.throws(
    () =>
      planAction({ action: 'deploy', generation: 'g1d', config: fresh, env, candidateExists: true, signer: deployer }),
    /deployment-already-started/,
  )
  assert.throws(
    () =>
      planAction({
        action: 'deploy-plan',
        generation: 'g1d',
        config: promoted,
        env,
        candidateExists: false,
        signer: deployer,
      }),
    /config-still-promoted/,
  )
  assert.throws(
    () =>
      planAction({ action: 'deploy', generation: 'g1d', config: fresh, env, candidateExists: false, signer: owner }),
    /deployer-config-mismatch/,
  )
  assert.throws(
    () =>
      planAction({
        action: 'deploy',
        generation: 'g1d',
        config: { ...fresh, chainId: 143 },
        env,
        candidateExists: false,
        signer: deployer,
      }),
    /fresh-testnet-config-required/,
  )
  assert.throws(
    () =>
      planAction({
        action: 'deploy',
        generation: 'g1d',
        config: fresh,
        env: { SIDEQUEST_TESTNET_SEND: '1' },
        candidateExists: false,
        signer: deployer,
      }),
    /rpc-url-required/,
  )
  const plan = planAction({
    action: 'deploy',
    generation: 'g1d',
    config: fresh,
    env,
    candidateExists: false,
    signer: deployer,
  })
  assert.equal(plan.sends, true)
  assert.deepEqual(plan.args.slice(0, 2), ['script', 'script/DeploySidequest.s.sol'])
  assert.ok(plan.args.includes('--keystore') && !plan.args.includes('--private-key'))
  assert.ok(plan.args.includes('--broadcast') && plan.args.includes('--slow'))
})

test('accept signs as the Safe owner; promote and verify use no keystore', () => {
  assert.equal(roleFor('accept'), 'SAFE_OWNER')
  assert.equal(roleFor('accept-plan'), 'SAFE_OWNER')
  assert.equal(roleFor('promote'), 'DEPLOYER')
  const accept = planAction({
    action: 'accept',
    generation: 'g1d',
    config: promoted,
    env,
    candidateExists: true,
    signer: owner,
  })
  assert.deepEqual(accept.args.slice(0, 2), ['script', 'script/SafeAccept.s.sol'])
  const promote = planAction({
    action: 'promote',
    generation: 'g1d',
    config: fresh,
    env,
    candidateExists: true,
    signer: deployer,
  })
  assert.ok(!promote.args.includes('--keystore') && !promote.args.includes('--broadcast'))
  const verify = planAction({
    action: 'verify',
    generation: 'g1d',
    config: promoted,
    env,
    candidateExists: true,
    signer: deployer,
  })
  assert.deepEqual(verify.args.slice(-2), ['--sig', 'check()'])
})
