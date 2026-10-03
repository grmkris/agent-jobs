import { expect, test } from 'vitest'
import { EpochNotEnded, miningOptions, requireEndedEpoch, requirePriceEpoch } from './testnet-mining-options.ts'

const readContract = async () => 100n

test('keeps the original epoch-0 command and accepts an explicit earned epoch', () => {
  expect(miningOptions(['prices.json', 'out', '--claim-key-env', 'WORKER_KEY'])).toMatchObject({ epoch: 0n })
  expect(miningOptions(['prices.json', 'out', '--claim-key-env', 'WORKER_KEY', '--epoch', '7'])).toMatchObject({ epoch: 7n })
  expect(() => miningOptions(['prices.json', 'out', '--claim-key-env', 'WORKER_KEY', '--epoch', '07'])).toThrow('usage:')
  expect(() => miningOptions(['prices.json', 'out', '--claim-key-env', 'WORKER_KEY', '--epoch', '-1'])).toThrow('usage:')
  expect(() => miningOptions(['prices.json', 'out', '--claim-key-env', 'WORKER_KEY', '--epoch', (2n ** 256n).toString()])).toThrow('uint256')
})

test('price input must name the selected epoch', () => {
  expect(() => requirePriceEpoch({ epoch: '2' }, 2n)).not.toThrow()
  expect(() => requirePriceEpoch({ message: { epoch: '2' } }, 2n)).not.toThrow()
  expect(() => requirePriceEpoch({ epoch: '1' }, 2n)).toThrow('selected epoch')
})

test('earned epoch waits for both latest and finalized chain time', async () => {
  const latest = { timestamp: 100n }, finalized = { timestamp: 99n }
  const client = { readContract, getBlock: async ({ blockTag }: { blockTag?: string } = {}) => blockTag === 'finalized' ? finalized : latest }
  await expect(requireEndedEpoch(client as never, '0x0000000000000000000000000000000000000001', 3n)).rejects.toBeInstanceOf(EpochNotEnded)
  const ended = { readContract, getBlock: async ({ blockTag }: { blockTag?: string } = {}) => blockTag === 'finalized' ? { timestamp: 100n } : { timestamp: 101n } }
  await expect(requireEndedEpoch(ended as never, '0x0000000000000000000000000000000000000001', 3n)).resolves.toBeUndefined()
})
