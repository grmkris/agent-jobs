import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { flowJson, parseFlowJson, type FlowState } from '../../packages/sdk/src/flow-journal.ts'
import { ensureFlowDirectory, saveFlowState } from '../../packages/sdk/scripts/flow-persistence.ts'
import { snapshotFixture, configFixture } from './test-fixtures/refund-snapshot.mjs'
import { makeManifest } from './refund-model.mjs'
import { bindRefundJournal, refundPlan, resumeDecision, validateSavedRefunds } from './refund-batch-model.mjs'

test('durable journal reload retains exact bytes, binding, hash and nonce without preparing a replacement', async () => {
  const manifest = makeManifest(snapshotFixture())
  const account = privateKeyToAccount(`0x${'01'.padStart(64, '0')}`)
  const plan = refundPlan(manifest, configFixture(account.address))
  const operation = plan.operations[0]
  const raw = await account.signTransaction({ type: 'eip1559', chainId: 10143, nonce: 1, to: operation.to, data: operation.data,
    value: 0n, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })
  const state: FlowState = { binding: '', values: {}, sends: { [operation.key]: { raw, hash: keccak256(raw), nonce: 1, wallet: account.address } } }
  // A signed record never gets attached to an empty binding.
  expect(() => bindRefundJournal(state, plan)).toThrow('unbound')
  state.binding = plan.binding
  const scratch = mkdtempSync(join(tmpdir(), 'g1d-refund-journal-'))
  const directory = pathToFileURL(join(scratch, 'state') + '/')
  try {
    ensureFlowDirectory(directory)
    saveFlowState(directory, state)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(new URL('journal.json', directory)).mode & 0o777).toBe(0o600)
    const reloaded = parseFlowJson(readFileSync(new URL('journal.json', directory), 'utf8'))
    bindRefundJournal(reloaded, plan)
    await validateSavedRefunds(reloaded, plan)
    expect(flowJson(reloaded)).toBe(flowJson(state))
    expect(resumeDecision(reloaded.sends[operation.key], undefined, 1)).toBe('replay-original-bytes')
    expect(() => resumeDecision(reloaded.sends[operation.key], undefined, 2)).toThrow('nonce consumed')
    expect(reloaded.sends[operation.key].raw).toBe(raw)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
