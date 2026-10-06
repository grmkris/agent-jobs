import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { keccak256, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { address, checksum, decodeVaultLogs, depositOwner, logKey, makeManifest, positionsFromSnapshot } from './refund-model.mjs'
import { bindRefundJournal, refundPlan, resumeDecision, validateSavedRefunds } from './refund-batch-model.mjs'

// Actual G1b logs and chain readbacks; unit tests never replace an RPC client.
const snapshot = JSON.parse(readFileSync(new URL('../../docs/evidence/testnet-g1c/refund-manifest.snapshot.json', import.meta.url)))
const manifest = JSON.parse(readFileSync(new URL('../../docs/evidence/testnet-g1c/refund-manifest.json', import.meta.url)))
const events = decodeVaultLogs(snapshot.vaultLogs)

test('full real G1b replay reconciles 26,836 SIDE, self-stake, mining and withdrawals', () => {
  assert.deepEqual(makeManifest(snapshot), manifest)
  assert.equal(manifest.positions.length, 10)
  assert.equal(manifest.totals.positions, '26836000000000000000000')
  assert.equal(manifest.positions.find(row => row.account === '0xB9970A6371358F6C74DFb15A7cB2653E3AE3E471').amount, '10000000000000000000000')
  const mining = events.filter(event => event.eventName === 'Staked' && address(event.args.payer) === snapshot.old.distributor)
  assert.equal(mining.length, 2)
  for (const event of mining) assert.equal(depositOwner(event, undefined, snapshot.old.distributor), address(event.args.account))
})

test('ownership variants use decoded deposits with explicit hypothetical registry proofs', () => {
  const funded = events.find(event => event.eventName === 'Staked' && event.args.account !== event.args.payer)
  const proof = { block: funded.block_number, agentId: '7', wallet: funded.args.account, owner: funded.args.payer }
  // G1b has no operator-funded deposit. These are pure proof variants, not live operator claims.
  assert.equal(depositOwner(funded, proof, zeroAddress), address(funded.args.payer))
  assert.equal(depositOwner(funded, undefined, zeroAddress), address(funded.args.account))
  assert.equal(depositOwner(funded, { ...proof, owner: zeroAddress }, zeroAddress), address(funded.args.account))
  assert.equal(depositOwner(funded, proof, snapshot.old.distributor), address(funded.args.account))
  assert.throws(() => depositOwner(funded, { ...proof, block: proof.block + 1 }, zeroAddress), /invalid operator proof/)
  const self = events.find(event => event.eventName === 'Staked' && event.args.account === event.args.payer)
  assert.equal(depositOwner(self, { ...proof, block: self.block_number, wallet: self.args.account, owner: self.args.payer }, zeroAddress), address(self.args.account))
})

test('real historical cooldown is included in the resulting position', () => {
  const requested = events.find(event => event.eventName === 'UnstakeRequested')
  const account = address(requested.args.account)
  const first = events.find(event => event.eventName === 'Staked' && address(event.args.account) === account)
  const partial = { ...snapshot, vaultLogs: snapshot.vaultLogs.filter(log => log.block_number <= requested.block_number &&
    [first.transaction_hash, requested.transaction_hash].includes(log.transaction_hash)), operatorProofs: {},
    accounts: [{ account, stake: (first.args.amount - requested.args.amount).toString(), unstaking: requested.args.amount.toString() }],
    totalStaked: (first.args.amount - requested.args.amount).toString(), totalUnstaking: requested.args.amount.toString() }
  const rows = positionsFromSnapshot(partial)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].amount, first.args.amount.toString())
  assert.equal(rows[0].unstaking, requested.args.amount.toString())
})

test('missing/duplicate logs, balance disagreement, and mixed-owner debits fail closed', () => {
  assert.throws(() => makeManifest({ ...snapshot, accounts: [] }), /missing chain read/)
  assert.throws(() => makeManifest({ ...snapshot, totalStaked: '0' }), /global stake totals/)
  assert.throws(() => makeManifest({ ...snapshot, vaultLogs: [...snapshot.vaultLogs, snapshot.vaultLogs[0]] }), /duplicate/)
  const mining = events.find(event => event.eventName === 'Staked' && event.args.account !== event.args.payer)
  const altered = structuredClone(snapshot)
  altered.old.distributor = zeroAddress
  altered.operatorProofs[logKey(mining)] = { block: mining.block_number, wallet: mining.args.account, owner: mining.args.payer, agentId: '7' }
  const debit = events.find(event => event.eventName === 'Slashed' && address(event.args.account) === address(mining.args.account))
  const laterDebit = { ...debit, block_number: snapshot.block + 1, log_index: 0 }
  altered.vaultLogs.push(laterDebit)
  assert.throws(() => makeManifest(altered), /ambiguous active debit/)
})

function planFixture(funding) {
  return refundPlan(manifest, { network: 'monad-testnet', chainId: 10143, roles: { admin: funding },
    sidequest: { allocation: { ecosystem: funding } }, deployment: {
      sidequest: { block: snapshot.block + 100, vault: '0x1111111111111111111111111111111111111111', factory: '0x2222222222222222222222222222222222222222' },
      main: { holding: '0x3333333333333333333333333333333333333333' },
    } })
}

test('journal binds manifest, funding and deployment; changing any refuses without rebinding', () => {
  const plan = planFixture(snapshot.accounts[0].account)
  const state = { binding: '', values: {}, sends: {} }
  bindRefundJournal(state, plan)
  bindRefundJournal(state, plan)
  const original = state.binding
  assert.throws(() => bindRefundJournal(state, { ...plan, binding: 'different' }), /binding changed/)
  assert.equal(state.binding, original)
  assert.throws(() => bindRefundJournal({ binding: '', values: { receipt: {} }, sends: {} }, plan), /unbound/)
  assert.throws(() => refundPlan({ ...manifest, checksum: 'modified' }, {}), /checksum/)
  assert.equal(checksum(snapshot), manifest.snapshot.checksum)
})

test('signed journal resume checks exact intent and requires receipts before counting completion', async () => {
  // Public disposable test key; only offline signing, no transaction is broadcast.
  const signer = privateKeyToAccount(`0x${'01'.padStart(64, '0')}`)
  const plan = planFixture(signer.address)
  const operation = plan.operations.find(row => row.key.startsWith('position/'))
  const raw = await signer.signTransaction({ type: 'eip1559', chainId: 10143, nonce: 2, to: operation.to,
    data: operation.data, value: 0n, gas: 300000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })
  const saved = { raw, hash: keccak256(raw), nonce: 2, wallet: signer.address }
  const state = { binding: plan.binding, values: {}, sends: { [operation.key]: saved } }
  await validateSavedRefunds(state, plan)
  assert.equal(resumeDecision(undefined, undefined, 0), 'prepare')
  assert.equal(resumeDecision(saved, undefined, 2), 'replay-original-bytes')
  assert.equal(resumeDecision(saved, { transactionHash: saved.hash, status: 'success' }, 3), 'confirmed')
  assert.throws(() => resumeDecision(saved, undefined, 3), /nonce consumed/)
  assert.throws(() => resumeDecision(saved, { transactionHash: saved.hash, status: 'reverted' }, 3), /failed/)
  await assert.rejects(validateSavedRefunds(state, { ...plan, operations: plan.operations.map(row => row.key === operation.key ? { ...row, data: '0x' } : row) }), /intent mismatch/)
  await assert.rejects(validateSavedRefunds({ ...state, sends: { [operation.key]: { ...saved, nonce: 3 } } }, plan), /intent mismatch/)
})
