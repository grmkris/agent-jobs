import { expect, test } from 'vitest'
import { deployment } from '../../packages/sdk/src/deployment.ts'
import { flowJson, parseFlowJson, type FlowState } from '../../packages/sdk/src/flow-journal.ts'
import { bindMiningState, miningBinding } from './testnet-mining-binding.ts'

const current = deployment('monad-testnet'), priceHash = 'a'.repeat(64), owner = current.hireling!.safe

test('binds the actual promoted SDK deployment with bigint block fields and survives journal serialization', () => {
  expect(typeof current.deployBlock).toBe('bigint')
  expect(typeof current.hireling!.block).toBe('bigint')
  expect(() => JSON.stringify(current)).toThrow()
  const binding = miningBinding(current, priceHash, owner, 0n)
  expect(binding).toMatch(/^[a-f0-9]{64}$/)
  const state: FlowState = { binding: '', sends: {}, values: {} }
  bindMiningState(state, binding)
  const loaded = parseFlowJson(flowJson(state))
  expect(() => bindMiningState(loaded, miningBinding(current, priceHash, owner, 0n))).not.toThrow()
  expect(loaded).toEqual(state)
  const copy = JSON.parse(flowJson(current), (_key, v) => v?.$bigint === undefined ? v : BigInt(v.$bigint))
  expect(miningBinding(copy, priceHash, owner, 0n)).toBe(binding)
})

test('binds exact bigint values, prices, owner and selected epoch independently', () => {
  const binding = miningBinding(current, priceHash, owner, 0n)
  for (const candidate of [
    miningBinding({ ...current, deployBlock: current.deployBlock + 1n }, priceHash, owner, 0n),
    miningBinding({ ...current, hireling: { ...current.hireling!, block: current.hireling!.block + 1n } }, priceHash, owner, 0n),
    miningBinding(current, 'b'.repeat(64), owner, 0n),
    miningBinding(current, priceHash, current.relay, 0n),
    miningBinding(current, priceHash, owner, 1n),
  ]) expect(candidate).not.toBe(binding)
})

test('refuses existing different bindings without changing saved values or sends', () => {
  const state: FlowState = { binding: 'historical-binding', values: { 'signed-prices': 'preserve' }, sends: {} }
  const before = flowJson(state)
  expect(() => bindMiningState(state, miningBinding(current, priceHash, owner, 0n))).toThrow('reconcile')
  expect(flowJson(state)).toBe(before)
})
