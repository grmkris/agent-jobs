import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { encodeEventTopics, erc20Abi } from 'viem'
import { verifySnapshotFresh } from './refund-batch.mjs'
import { KRIS, makeManifest } from './refund-model.mjs'
import { snapshotFixture, addr, hash } from './test-fixtures/refund-snapshot.mjs'

const snapshot = snapshotFixture()
const manifest = makeManifest(snapshot)
function tokenLog(eventName, args) {
  return { address: snapshot.old.factory, blockNumber: 111n, logIndex: 0, transactionHash: hash('8'), removed: false,
    topics: encodeEventTopics({ abi: erc20Abi, eventName, args }), data: '0x' + '1'.padStart(64, '0') }
}
const client = (logs, blockHash = snapshot.blockHash) => ({
  getBlock: async request => request.blockTag ? { number: 112n } : { hash: blockHash },
  getLogs: async () => logs,
})

test('unrelated old-SIDE Approval and Transfer after the fixed cutoff do not block or count', async () => {
  for (const log of [tokenLog('Approval', { owner: addr('9'), spender: addr('8') }),
    tokenLog('Transfer', { from: addr('9'), to: addr('8') })]) {
    assert.deepEqual(await verifySnapshotFresh(client([log]), snapshot, manifest),
      { throughBlock: 112, oldVaultEvents: 0, oldSideTransfers: 0 })
  }
})

test('later transfers touching a position account, delegator or Kris are reported without refusing', async () => {
  for (const wallet of [manifest.positions[0].account, manifest.positions[0].delegator, KRIS]) {
    for (const args of [{ from: wallet, to: addr('9') }, { from: addr('9'), to: wallet }]) {
      const report = await verifySnapshotFresh(client([tokenLog('Transfer', args)]), snapshot, manifest)
      assert.equal(report.oldSideTransfers, 1)
    }
  }
})

test('old-vault events after the cutoff are reported without refusing', async () => {
  const log = { ...tokenLog('Transfer', { from: addr('9'), to: addr('8') }), address: snapshot.old.vault }
  assert.equal((await verifySnapshotFresh(client([log]), snapshot, manifest)).oldVaultEvents, 1)
})

test('a changed snapshot block hash still refuses', async () => {
  await assert.rejects(verifySnapshotFresh(client([], hash('f')), snapshot, manifest), /snapshot block hash changed/)
})
