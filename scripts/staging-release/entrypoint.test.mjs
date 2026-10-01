import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { validatePackageBoundary } from './entrypoint.mjs'
import { syntheticEvidence } from './fixtures/synthetic-evidence.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repository = join(scriptDir, '../..')

const packageManifest = { scripts: { 'deploy:staging': 'node scripts/staging-release/release.mjs', 'staging:review': 'node scripts/staging-release/guard.mjs', 'staging:digests': 'node scripts/staging-release/digests.mjs' } }

test('package boundary points staging directly at the local guard with no lifecycle fallback', () => {
  assert.equal(validatePackageBoundary(packageManifest), true)
  assert.equal(validatePackageBoundary({ scripts: { ...packageManifest.scripts, 'predeploy:staging': 'alchemy deploy' } }), false)
  assert.equal(validatePackageBoundary({ scripts: { ...packageManifest.scripts, 'deploy:staging': 'ALCHEMY_REMOTE_STATE=1 alchemy deploy --stage staging --yes' } }), false)
  for (const name of ['deploy:staging', 'staging:review', 'staging:digests']) {
    for (const prefix of ['pre', 'post']) assert.equal(validatePackageBoundary({ scripts: { ...packageManifest.scripts, [`${prefix}${name}`]: 'untrusted-hook' } }), false)
  }
  const actual = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'))
  assert.equal(validatePackageBoundary(actual), true)
  assert.equal(actual.scripts['deploy:prod'], 'AGENT_JOBS_NETWORK=monad-mainnet AGENT_JOBS_STAGE=prod ALCHEMY_REMOTE_STATE=1 alchemy deploy --stage prod --yes')
})

test('valid synthetic evidence, malformed inputs and flags all retain root release HOLD', () => {
  const root = mkdtempSync(join(scriptDir, 'entrypoint-fixture-'))
  try {
    const synthetic = join(root, 'synthetic.json')
    const malformed = join(root, 'malformed.json')
    writeFileSync(synthetic, JSON.stringify(syntheticEvidence()))
    writeFileSync(malformed, '{untrusted-marker')
    for (const args of [[synthetic], [malformed], ['--apply'], ['--execute', 'untrusted-marker'], [synthetic, '--apply'], ['/etc/hosts']]) {
      const child = spawnSync(process.execPath, [join(scriptDir, 'entrypoint.mjs'), ...args], { encoding: 'utf8', timeout: 10_000 })
      assert.equal(child.error, undefined)
      assert.equal(child.status, 1)
      const output = JSON.parse(child.stdout)
      assert.equal(output.ok, false)
      assert.equal(output.applyAuthorized, false)
      assert.equal(output.releaseReady, false)
      assert.equal(output.deployCommand, null)
      assert.ok(output.blockers.includes('live-release-hold'))
      if (args[0] === synthetic && args.length === 1) assert.equal(output.packetValid, true)
      assert.ok(!child.stdout.includes('untrusted-marker'))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the exact user-facing pnpm dispatch executes only the held local Node guard', () => {
  const root = mkdtempSync(join(scriptDir, 'entrypoint-fixture-'))
  try {
    const userConfig = join(root, 'user-config')
    const globalConfig = join(root, 'global-config')
    const synthetic = join(root, 'synthetic.json')
    const malformed = join(root, 'malformed.json')
    writeFileSync(userConfig, '')
    writeFileSync(globalConfig, '')
    writeFileSync(synthetic, JSON.stringify(syntheticEvidence()))
    writeFileSync(malformed, '{untrusted-marker')
    const environment = {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: root,
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
      npm_config_manage_package_manager_versions: 'false',
      COREPACK_ENABLE_NETWORK: '0',
      COREPACK_HOME: process.env.COREPACK_HOME ?? '/home/kristjan/.cache/node/corepack',
    }
    for (const args of [[], [synthetic], [malformed], ['--apply'], ['--provider-command', 'untrusted-marker']]) {
      const child = spawnSync('pnpm', ['--silent', 'run', 'deploy:staging', ...args], { cwd: repository, env: environment, encoding: 'utf8', timeout: 15_000 })
      assert.equal(child.error, undefined)
      assert.equal(child.status, 1)
      const output = JSON.parse(child.stdout.trim())
      assert.equal(output.ok, false)
      assert.equal(output.applyAuthorized, false)
      assert.equal(output.deployCommand, null)
      assert.ok(output.blockers.includes('live-release-hold'))
      assert.ok(!child.stdout.includes('untrusted-marker'))
      assert.ok(!child.stdout.includes('alchemy'))
      if (args[0] === synthetic) assert.equal(output.packetValid, true)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('root deploy entrypoint always returns a nonzero sanitized hold without provider execution', () => {
  const result = spawnSync(process.execPath, ['scripts/staging-release/entrypoint.mjs'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  const output = JSON.parse(result.stdout)
  assert.equal(output.ok, false)
  assert.equal(output.applyAuthorized, false)
  assert.equal(output.deployCommand, null)
  assert.equal(output.mutation, 'forbidden')
  assert.ok(output.blockers.includes('live-release-hold'))
  assert.ok(!result.stdout.includes('alchemy'))
  assert.ok(!result.stdout.includes('CLOUDFLARE'))
})

test('staging review refuses unknown flags and never turns review success into release success', () => {
  for (const args of [['--apply'], ['--execute-alchemy'], ['fixtures/unavailable-build.json', '--apply']]) {
    const result = spawnSync(process.execPath, ['scripts/staging-release/guard.mjs', ...args], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    const output = JSON.parse(result.stdout)
    assert.equal(output.applyAuthorized, false)
    assert.equal(output.deployCommand, null)
    assert.ok(!result.stdout.includes('unavailable-build'))
  }
})
