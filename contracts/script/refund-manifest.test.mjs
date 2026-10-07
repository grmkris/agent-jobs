import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { captureSnapshot, parseManifestArgs, readLogs } from './refund-manifest.mjs'
import { address, KRIS, makeManifest } from './refund-model.mjs'
import { snapshotFixture, addr, hash } from './test-fixtures/refund-snapshot.mjs'

const snapshot = snapshotFixture()
const config = { chainId: 10143, network: 'monad-testnet', sidequest: { allocation: { ecosystem: addr('9') } }, deployment: { core: snapshot.old.core, main: { holding: snapshot.old.holding }, sidequest: snapshot.old, testnetFaucet: addr('8') } }

function reader() {
  const calls = []
  const client = {
    getChainId: async () => 10143,
    getBlock: async request => request.blockTag ? { number: 110n } : { hash: snapshot.blockHash, timestamp: 1000n },
    readContract: async request => {
      calls.push(request)
      const row = snapshot.accounts.find(a => address(a.account) === request.args[0])
      switch (request.functionName) {
        case 'factory': return snapshot.old.factory
        case 'poolOf': return row.pool
        case 'positionOf': return row.positions.find(p => address(p.delegator) === request.args[1])
        case 'convertToAssets': return request.args[1] === '0' ? 0n : row.positions.find(p => p.shares === request.args[1]).assets
        case 'balanceOf': return request.args[0] === KRIS ? 100000n : 9997000n
        case 'totalAssets': return 1800n
        default: throw new Error(`unexpected read ${request.functionName}`)
      }
    },
  }
  return { client, calls, readLogs: async (from, through, addresses) => {
    assert.deepEqual([from, through, addresses], [100, 110, [snapshot.old.vault]])
    return snapshot.vaultLogs
  } }
}

test('snapshot enumeration and every pool, position and loose-token read are pinned to --block', async () => {
  const fixture = reader()
  const captured = await captureSnapshot(config, 110, undefined, fixture)
  assert.ok(fixture.calls.every(call => call.blockNumber === 110n))
  assert.equal(captured.accounts.length, 2)
  assert.equal(captured.accounts.flatMap(row => row.positions).length, 4)
  assert.equal(captured.excluded.length, 2)
  assert.equal(makeManifest(captured).positions.length, 3)
})

test('wrong-chain, non-finalized and changed-block snapshots refuse before writing output', async () => {
  const f = reader()
  await assert.rejects(captureSnapshot(config, 111, undefined, f), /not finalized/u)
  await assert.rejects(captureSnapshot(config, 110, undefined, { ...f, client: { ...f.client, getChainId: async () => 143 } }), /chain 10143/u)
  let blocks = 0
  await assert.rejects(captureSnapshot(config, 110, undefined, { ...f, client: { ...f.client, getBlock: async request => request.blockTag ? { number: 110n } : { hash: ++blocks === 1 ? hash('1') : hash('2'), timestamp: 1000n } } }), /hash changed/u)
})

test('manifest requires the archived config path and an explicit block', () => {
  assert.throws(() => parseManifestArgs([]), /required/u)
  assert.throws(() => parseManifestArgs(['--config', 'contracts/config/monad-testnet.json', '--block', '110']), /archived/u)
  const options = parseManifestArgs(['--config', 'contracts/config/archive/pre-g1d-monad-testnet.json', '--block', '110'])
  assert.equal(options.block, 110)
})

test('public log pagination covers the inclusive snapshot boundary and refuses foreign/incomplete rows', async () => {
  const ranges = []
  const client = { getLogs: async request => { ranges.push([request.fromBlock, request.toBlock]); return [] } }
  await readLogs(100, 110, [addr('a')], client, 5)
  assert.deepEqual(ranges, [[100n, 104n], [105n, 109n], [110n, 110n]])
  await assert.rejects(readLogs(100, 110, [addr('a')], { getLogs: async () => [{ blockNumber: 100n, logIndex: 0, transactionHash: hash('1'), address: addr('b') }] }), /foreign/u)
})
