import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { archive, withOperationLock } from './contracts.mjs'
import {
  archivePath,
  candidatePath,
  LOCKED_OPERATIONS,
  operationLockPath,
  parseArgs,
  planAction,
  resetConfig,
  roleFor,
} from './contracts-model.mjs'

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

void test('every action needs an explicit generation label', () => {
  assert.throws(() => parseArgs(['deploy']), /generation-required/)
  assert.throws(() => parseArgs(['deploy', '--generation', 'G1D']), /generation-required/)
  assert.throws(() => parseArgs(['launch', '--generation', 'g1d']), /invalid-contract-action/)
  assert.deepEqual(parseArgs(['deploy', '--generation', 'g1d']), { action: 'deploy', generation: 'g1d' })
  assert.equal(candidatePath('g1d'), 'contracts/broadcast/sidequest-g1d/sidequest/monad-testnet.candidate.json')
  assert.equal(archivePath('g1d'), 'contracts/config/archive/pre-g1d-monad-testnet.json')
})

void test('archive keeps every top-level key and only the reward tokens of the old deployment', () => {
  assert.deepEqual(Object.keys(fresh), Object.keys(promoted))
  assert.deepEqual(fresh.deployment, { rewardTokens: ['0xmusd', '0xmeur'] })
  assert.deepEqual(fresh.boards, promoted.boards)
  assert.throws(() => resetConfig(fresh), /config-not-promoted-nothing-to-archive/)
  assert.throws(() => resetConfig({ ...promoted, chainId: 143 }), /fresh-testnet-config-required/)
})

void test('sending actions refuse without SIDEQUEST_TESTNET_SEND and plans never broadcast', () => {
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

void test('deploy refuses a promoted config, an existing candidate and a foreign deployer', () => {
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

void test('accept signs as the Safe owner; promote and verify use no keystore', () => {
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

function temporary(operation) {
  const root = mkdtempSync(join(tmpdir(), 'g1d-contracts-test-'))
  try {
    return operation(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

void test('archive, deploy, promote and accept share an exclusive generation operation lock', () =>
  temporary((root) => {
    assert.deepEqual([...LOCKED_OPERATIONS], ['archive', 'deploy', 'promote', 'accept'])
    assert.equal(operationLockPath('g1d'), '.sidequest/contracts-g1d.lock')
    const lock = join(root, 'contracts-g1d.lock')
    withOperationLock(
      'g1d',
      () => {
        assert.equal(readFileSync(lock, 'utf8'), String(process.pid) + '\n')
        for (const action of LOCKED_OPERATIONS) {
          let ran = false
          assert.throws(
            () =>
              withOperationLock(
                'g1d',
                () => {
                  ran = true
                },
                root,
              ),
            (error) => error.message.startsWith('operation-in-progress ') && error.message.includes(lock),
            action,
          )
          assert.equal(ran, false)
        }
      },
      root,
    )
    assert.equal(existsSync(lock), false)
  }))

void test('a pre-existing lock is preserved; errors release only the acquired lock', () =>
  temporary((root) => {
    const lock = join(root, 'contracts-g1d.lock')
    writeFileSync(lock, 'old-pid\n')
    assert.throws(
      () =>
        withOperationLock(
          'g1d',
          () => {
            throw new Error('must not run')
          },
          root,
        ),
      /operation-in-progress/,
    )
    assert.equal(readFileSync(lock, 'utf8'), 'old-pid\n')
    rmSync(lock)
    assert.throws(
      () =>
        withOperationLock(
          'g1d',
          () => {
            throw new Error('controlled failure')
          },
          root,
        ),
      /controlled failure/,
    )
    assert.equal(existsSync(lock), false)
  }))

void test('explicit process exit releases the operation lock', () =>
  temporary((root) => {
    const result = spawnSync('node', [
      '--input-type=module',
      '-e',
      `import { withOperationLock } from ${JSON.stringify(new URL('./contracts.mjs', import.meta.url).href)};
    withOperationLock('g1d', () => process.exit(7), ${JSON.stringify(root)});`,
    ])
    assert.equal(result.status, 7, result.stderr.toString())
    assert.equal(existsSync(join(root, 'contracts-g1d.lock')), false)
  }))

void test('an existing archive refuses without overwriting it or resetting the config', () =>
  temporary((root) => {
    const configPath = join(root, 'config.json'),
      target = join(root, 'archive.json')
    const bytes = JSON.stringify(promoted)
    writeFileSync(configPath, bytes)
    writeFileSync(target, 'original archive')
    assert.throws(() => archive('g1d', configPath, target), /archive-exists/)
    assert.equal(readFileSync(target, 'utf8'), 'original archive')
    assert.equal(readFileSync(configPath, 'utf8'), bytes)
  }))

void test('the exclusive archive preserves the exact bytes of the single config read', () =>
  temporary((root) => {
    const configPath = join(root, 'config.json'),
      target = join(root, 'archive.json')
    const bytes = Buffer.from(' \r\n' + JSON.stringify(promoted, null, 4) + '\r\n')
    writeFileSync(configPath, bytes)
    const probe = spawnSync('node', [
      '--input-type=module',
      '-e',
      `import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { archive } from ${JSON.stringify(new URL('./contracts.mjs', import.meta.url).href)};
    const read = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function(path, ...rest) {
      const bytes = read(path, ...rest);
      if (path === ${JSON.stringify(configPath)}) {
        reads++;
        // Simulate a second writer changing the source between the read and archival.
        fs.writeFileSync(path, JSON.stringify(${JSON.stringify(fresh)}));
      }
      return bytes;
    };
    syncBuiltinESMExports();
    archive('g1d', ${JSON.stringify(configPath)}, ${JSON.stringify(target)});
    if (reads !== 1) throw new Error('config-read-more-than-once');`,
    ])
    assert.equal(probe.status, 0, probe.stderr.toString())
    assert.deepEqual(readFileSync(target), bytes)
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), fresh)
  }))
