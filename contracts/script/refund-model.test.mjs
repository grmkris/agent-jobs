import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData, erc20Abi, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { KRIS, address, checksum, decodeVaultLogs, makeManifest, positionsFromSnapshot, validateManifest } from './refund-model.mjs'
import { bindRefundJournal, refundPlan, refundSendMode, resumeDecision, validateSavedRefunds, refundVaultAbi } from './refund-batch-model.mjs'
import { snapshotFixture, configFixture, addr } from './test-fixtures/refund-snapshot.mjs'

const snapshot = snapshotFixture(), manifest = makeManifest(snapshot)

test('all current share positions retain their delegators and queued value after a slash/reset', () => {
  assert.equal(decodeVaultLogs(snapshot.vaultLogs).length, 8)
  assert.equal(manifest.positions.length, 3)
  assert.equal(manifest.totals.positions, '1800')
  assert.equal(manifest.totals.transfers, '100000')
  assert.equal(manifest.positions[0].amount, '750')
  assert.equal(manifest.positions[0].unstaking, '375')
  assert.equal(manifest.positions[1].delegator, addr('2')) // payer was addr('9')
  assert.equal(manifest.positions[2].generation, '1')
  assert.deepEqual(manifest.transfers.map(row => row.wallet), [KRIS])
  assert.equal(manifest.excluded.length, 2)
  assert.equal(validateManifest(manifest), manifest)
})

test('missing/duplicate positions/logs, inconsistent prices/queues/generations/totals fail closed', () => {
  const variants = [
    s => s.accounts.splice(0, 1),
    s => s.accounts[0].positions.pop(),
    s => s.accounts[0].positions.push(s.accounts[0].positions[0]),
    s => s.vaultLogs.push(s.vaultLogs[0]),
    s => { s.totalAssets = '1' },
    s => { s.accounts[0].positions[0].assets = '751' },
    s => { s.accounts[0].positions[0].queuedShares = '1001' },
    s => { s.accounts[0].positions[0].generation = '2' },
    s => s.looseBalances.push({ wallet: addr('9'), amount: '1' }),
  ]
  for (const mutate of variants) { const s = structuredClone(snapshot); mutate(s); assert.throws(() => makeManifest(s), /refund:/u) }
})

test('rounding is per-position current asset value and records unallocated pool dust', () => {
  const s = structuredClone(snapshot)
  s.accounts[0].pool.assets = '1499'
  s.accounts[0].positions.forEach(p => { p.assets = '749' })
  s.totalAssets = '1799'
  const m = makeManifest(s)
  assert.equal(m.totals.positions, '1798')
  assert.equal(m.totals.roundingDust, '1')
  assert.equal(positionsFromSnapshot(s)[0].unstaking, '374')
})

test('batch funds from ecosystem, approves the new vault, delegates each position, then transfers only to Kris', () => {
  const plan = refundPlan(manifest, configFixture(addr('1')))
  assert.notEqual(plan.funding, configFixture(addr('1')).roles.admin)
  assert.equal(plan.operations.length, 5)
  const approval = decodeFunctionData({ abi: erc20Abi, data: plan.operations[0].data })
  assert.equal(approval.functionName, 'approve')
  assert.deepEqual(approval.args, [addr('5'), 1800n])
  const position = decodeFunctionData({ abi: refundVaultAbi, data: plan.operations[2].data })
  assert.deepEqual(position.args, [addr('1'), addr('2'), 750n])
  const transfer = decodeFunctionData({ abi: erc20Abi, data: plan.operations.at(-1).data })
  assert.deepEqual(transfer.args, [KRIS, 100000n])
})

test('journal binds manifest, funding and deployment and rejects unknown signed operations', () => {
  const plan = refundPlan(manifest, configFixture(addr('1'))), state = { binding: '', values: {}, sends: {} }
  bindRefundJournal(state, plan)
  bindRefundJournal(state, plan)
  assert.throws(() => bindRefundJournal(state, { ...plan, binding: 'different' }), /binding changed/u)
  assert.throws(() => bindRefundJournal({ binding: '', values: { receipt: {} }, sends: {} }, plan), /unbound/u)
  assert.throws(() => bindRefundJournal({ ...state, sends: { wrong: {} } }, plan), /unknown operation/u)
  assert.throws(() => refundPlan({ ...manifest, checksum: 'modified' }, {}), /checksum/u)
  assert.equal(checksum(snapshot), manifest.snapshot.checksum)
})

test('the snapshot cutoff is the new deployment block minus one, never the archived deployment block', () => {
  const config = configFixture(addr('1'))
  assert.equal(config.deployment.sidequest.block, snapshot.block + 1)
  assert.ok(snapshot.old.block < snapshot.block)
  assert.doesNotThrow(() => refundPlan(manifest, config))
  config.deployment.sidequest.block++
  assert.throws(() => refundPlan(manifest, config), /snapshot must precede the new deployment by one block/u)
})

test('signed resume retains exact bytes; nonce consumption without a successful matching receipt refuses', async () => {
  const signer = privateKeyToAccount(`0x${'01'.padStart(64, '0')}`) // public test key; offline only
  const plan = refundPlan(manifest, configFixture(signer.address)), operation = plan.operations[1]
  const raw = await signer.signTransaction({ type: 'eip1559', chainId: 10143, nonce: 2, to: operation.to, data: operation.data, value: 0n, gas: 300000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })
  const saved = { raw, hash: keccak256(raw), nonce: 2, wallet: signer.address }, state = { binding: plan.binding, values: {}, sends: { [operation.key]: saved } }
  await validateSavedRefunds(state, plan)
  assert.equal(resumeDecision(undefined, undefined, 0), 'prepare')
  assert.equal(resumeDecision(saved, undefined, 2), 'replay-original-bytes')
  assert.equal(resumeDecision(saved, { transactionHash: saved.hash, status: 'success' }, 3), 'confirmed')
  assert.throws(() => resumeDecision(saved, undefined, 3), /nonce consumed/u)
  assert.throws(() => resumeDecision(saved, { transactionHash: saved.hash, status: 'reverted' }, 3), /failed/u)
  await assert.rejects(validateSavedRefunds(state, { ...plan, operations: plan.operations.map(row => row.key === operation.key ? { ...row, data: '0x' } : row) }), /intent mismatch/u)
  await assert.rejects(validateSavedRefunds({ ...state, sends: { [operation.key]: { ...saved, nonce: 3 } } }, plan), /intent mismatch/u)
})

test('dry-run is the default and --yes cannot bypass the explicit send environment gate', () => {
  assert.equal(refundSendMode(false, {}), false)
  assert.throws(() => refundSendMode(true, {}), /SIDEQUEST_TESTNET_SEND/u)
  assert.throws(() => refundSendMode(true, { SIDEQUEST_TESTNET_SEND: '0' }), /SIDEQUEST_TESTNET_SEND/u)
  assert.equal(address(manifest.transfers[0].wallet), KRIS)
})
