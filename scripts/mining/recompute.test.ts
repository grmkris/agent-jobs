import { expect, test } from 'bun:test'
import epoch29 from './fixtures/testnet-epoch-29.json'
import { artifactPrices, firstEpochDiff, rebuildRecorded, recomputeLots } from './recompute.ts'
import { replayLots } from './lots.ts'
import { parsePriceList } from './prices.ts'

test('later funding is excluded from the lot replay but included in the full funding integrity sum', () => {
  const funding = [
    { epoch: 28n, amount: 100n },
    { epoch: 29n, amount: 200n },
    { epoch: 30n, amount: 300n },
  ]
  expect(recomputeLots(29n, funding, 600n)).toEqual(replayLots(29n, funding.slice(0, 2)))
  expect(() => recomputeLots(29n, funding, 300n)).toThrow('sum')
  expect(() => replayLots(29n, funding)).toThrow('later epochs')
})

test('the previous signed list is reconstructed entirely from the artifact evidence', () => {
  const prices = artifactPrices(epoch29)
  expect(prices.pricesFile).toEqual(epoch29.priceList)
  expect(parsePriceList(prices.previousFile!).epoch).toBe(28n)
  expect(prices.previousFile?.signature).toBe(epoch29.inputs.factoryPriceEvidence.previousSignedPrice.signature)
  expect(prices.previousFile?.signer).toBe(epoch29.inputs.factoryPriceEvidence.previousSignedPrice.signer)
  expect(parsePriceList(prices.previousFile!).factoryUsdPrice).toBe(BigInt(epoch29.factoryUsdPrice))
})

test('byte comparison detects input key-order changes and reports the first differing artifact field', () => {
  const rebuilt = rebuildRecorded(epoch29)
  expect(firstEpochDiff(epoch29, rebuilt)).toBeNull()
  const inputs = { ...epoch29.inputs, epoch: '30' }
  expect(firstEpochDiff(epoch29, { ...rebuilt, inputs })).toStartWith('inputs:')
  expect(firstEpochDiff(epoch29, { ...rebuilt, dataHash: '0x00' })).toStartWith('dataHash:')
  expect(firstEpochDiff(epoch29, { ...rebuilt, tree: null })).toStartWith('tree:')
  expect(firstEpochDiff(epoch29, { ...rebuilt, claims: {} })).toStartWith('claims:')
  const { chainId, ...rest } = epoch29.inputs
  expect(firstEpochDiff(epoch29, { ...rebuilt, inputs: { ...rest, chainId } })).toStartWith('inputs:')
})

test('malformed recorded artifact boundaries refuse before any computation', () => {
  for (const patch of [{ inputs: null }, { epoch: '1.5' }, { inputs: { ...epoch29.inputs, budget: { available: 1 } } }])
    expect(() => rebuildRecorded({ ...epoch29, ...patch })).toThrow()
})
