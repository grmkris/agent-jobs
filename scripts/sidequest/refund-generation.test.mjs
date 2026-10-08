import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBatchArgs } from '../../contracts/script/refund-batch.mjs'
import { captureSnapshot, parseManifestArgs } from '../../contracts/script/refund-manifest.mjs'
import { refundIdentity, refundPaths } from '../../contracts/script/refund-generation.mjs'
import { bindRefundJournal, refundPlan } from '../../contracts/script/refund-batch-model.mjs'
import { KRIS, makeManifest, validateManifest } from '../../contracts/script/refund-model.mjs'
import { snapshotFixture, configFixture, addr } from '../../contracts/script/test-fixtures/refund-snapshot.mjs'

void test('G1d defaults preserve the existing manifest and journal paths; G1e isolates both', () => {
  assert.deepEqual(refundPaths(), {
    directory: '.g1d-refunds',
    manifest: 'docs/evidence/testnet-g1d/refund-manifest.json',
  })
  assert.deepEqual(refundIdentity('g1e', 'g1d'), { generation: 'g1e', source: 'g1d' })
  assert.equal(refundPaths('g1e').directory, '.g1e-refunds')
  const args = ['--generation', 'g1e', '--source', 'g1d']
  assert.equal(parseBatchArgs(args).manifest, 'docs/evidence/testnet-g1e/refund-manifest.json')
  const manifestArgs = parseManifestArgs([
    ...args,
    '--config',
    'contracts/config/archive/pre-g1e-monad-testnet.json',
    '--block',
    '110',
    '--kris-side',
    '20000',
  ])
  assert.equal(manifestArgs.out, 'docs/evidence/testnet-g1e/refund-manifest.json')
  assert.equal(manifestArgs.krisSide, '20000')
})

void test('generation/source mismatches cannot reuse checksummed manifests or signed journals', () => {
  const old = makeManifest(snapshotFixture())
  const identity = { generation: 'g1e', source: 'g1d' }
  const next = makeManifest(snapshotFixture(), identity)
  assert.equal(old.from, 'pre-g1d')
  assert.equal(old.to, 'g1d')
  assert.equal(next.from, 'g1d')
  assert.equal(next.to, 'g1e')
  assert.throws(() => validateManifest(old, identity), /identity\/checksum/)
  const a = refundPlan(old, configFixture(addr('1')))
  const b = refundPlan(next, configFixture(addr('1')), identity)
  assert.notEqual(a.binding, b.binding)
  assert.throws(() => bindRefundJournal({ binding: a.binding, values: {}, sends: {} }, b), /binding changed/)
  assert.throws(
    () => refundPlan(next, configFixture(addr('1')), { generation: 'g1d', source: 'pre-g1d' }),
    /identity\/checksum/,
  )
})

void test('path traversal, equal generations and duplicate CLI flags fail closed', () => {
  for (const label of ['../g1e', 'G1e', 'g1e/other', 'a'.repeat(33), ''])
    assert.throws(() => refundPaths(label), /invalid generation/)
  assert.throws(() => refundIdentity('g1e', 'g1e'), /invalid generation/)
  assert.throws(() => parseBatchArgs(['--generation', 'g1e', '--generation', 'g1e']), /duplicate/)
  assert.throws(
    () =>
      parseManifestArgs([
        '--config',
        'contracts/config/archive/pre-g1e-monad-testnet.json',
        '--block',
        '110',
        '--kris-side',
        '-1',
      ]),
    /Kris allocation/,
  )
})

void test('G1e captures the explicit 20,000 SIDE allocation without reading Kris liquid G1d balance', async () => {
  const snapshot = snapshotFixture()
  const config = {
    chainId: 10143,
    network: 'monad-testnet',
    sidequest: { allocation: {} },
    deployment: {
      core: snapshot.old.core,
      main: { holding: snapshot.old.holding },
      sidequest: snapshot.old,
    },
  }
  const calls = []
  const client = {
    getChainId: async () => 10143,
    getBlock: async (request) => (request.blockTag ? { number: 110n } : { hash: snapshot.blockHash, timestamp: 1000n }),
    readContract: async (request) => {
      calls.push(request)
      switch (request.functionName) {
        case 'factory':
          return snapshot.old.factory
        case 'decimals':
          return 18
        case 'totalAssets':
          return 0n
        case 'balanceOf':
          throw new Error('liquid SIDE must not be migrated')
        default:
          throw new Error(`unexpected read ${request.functionName}`)
      }
    },
  }
  const captured = await captureSnapshot(config, 110, undefined, { client, readLogs: async () => [] }, '20000')
  const manifest = makeManifest(captured, { generation: 'g1e', source: 'g1d' })
  assert.deepEqual(
    manifest.transfers.map(({ wallet, amount }) => ({ wallet, amount })),
    [{ wallet: KRIS, amount: '20000000000000000000000' }],
  )
  assert.equal(
    calls.some((call) => call.functionName === 'balanceOf'),
    false,
  )
  assert.ok(calls.every((call) => call.blockNumber === 110n))
})
