import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadEnv } from './transaction.mjs'

void test('a stage run reads that stage key file and a missing file refuses', () => {
  const home = mkdtempSync(join(tmpdir(), 'sq-stage-env-'))
  try {
    mkdirSync(join(home, '.config', 'sidequest'), { recursive: true })
    writeFileSync(
      join(home, '.config', 'sidequest', 'dev.env'),
      'DEPLOYER_PRIVATE_KEY=0xstage\nMONAD_RPC_URL=https://rpc.invalid\n',
    )
    const env = loadEnv({ SIDEQUEST_STAGE: 'dev', DEPLOYER_PRIVATE_KEY: '0xshell' }, home)
    assert.equal(env.DEPLOYER_PRIVATE_KEY, '0xstage')
    assert.equal(env.MONAD_RPC_URL, 'https://rpc.invalid')
    assert.throws(() => loadEnv({ SIDEQUEST_STAGE: 'prod' }, home), /stage-env-missing prod/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('a local run reads .env.local and an unknown stage reads no file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sq-local-env-'))
  const cwd = process.cwd()
  try {
    writeFileSync(
      join(dir, '.env.local'),
      'CREATOR_PRIVATE_KEY=0xlocal\nMONAD_TESTNET_RPC_URL=https://testnet.invalid\n',
    )
    process.chdir(dir)
    const env = loadEnv({}, dir)
    assert.equal(env.CREATOR_PRIVATE_KEY, '0xlocal')
    assert.equal(env.MONAD_RPC_URL, 'https://testnet.invalid')
    assert.equal(loadEnv({ SIDEQUEST_STAGE: 'ci', CREATOR_PRIVATE_KEY: '0xci' }, dir).CREATOR_PRIVATE_KEY, '0xci')
  } finally {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  }
})
