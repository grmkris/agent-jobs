import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import epoch29 from './fixtures/testnet-epoch-29.json'
import { epochEntry } from './epoch.ts'
import { rebuildRecorded, firstEpochDiff } from './recompute.ts'

// Copied verbatim from the lane base; normal v1 runs still execute this exact file.
const v1SourceHash = createHash('sha256')
  .update(readFileSync(new URL('./epoch-v1.ts', import.meta.url)))
  .digest('hex')

test('the recorded v1 epoch 29 rebuilds every leaf, node, claim, total and input hash offline', () => {
  const rebuilt = rebuildRecorded(epoch29)
  expect(firstEpochDiff(epoch29, rebuilt)).toBeNull()
  expect(rebuilt.result.feeUsd.toString()).toBe(epoch29.feeUsd)
  expect(rebuilt.result.demand.toString()).toBe(epoch29.demand)
  expect(rebuilt.result.emission.toString()).toBe(epoch29.emission)
  expect(rebuilt.tree).toEqual(epoch29.tree)
  expect(rebuilt.claims).toEqual(epoch29.claims)
})

test('the entry point dispatches v1 below cutover, v2 at cutover, and v1 without a configured rule', () => {
  const config = { mining: { creditRule: { fromEpoch: '30' } } }
  expect(epochEntry(config, 29n)).toBe('./epoch-v1.ts')
  expect(epochEntry(config, 30n)).toBe('./epoch-v2.ts')
  expect(epochEntry({}, 999n)).toBe('./epoch-v1.ts')
})

test('the v1 executable retains the original entry point bytes', () => {
  expect(v1SourceHash).toBe('96100c8c8ada02d69ecced3fe90ae0740887ecc54e25d3ea3641dcd73652897f')
})
