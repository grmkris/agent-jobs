import { expect, test } from 'bun:test'
import { creatorWeights, type TopUp } from './contributors.ts'
import type { FeeCharged } from './compute.ts'
import type { Address, Hex } from './viem.ts'

const address = (digit: string) => `0x${digit.repeat(40)}` as Address
const position = { block: 10n, logIndex: 1, tx: `0x${'1'.repeat(64)}` as Hex, holding: address('1') }
const fee: FeeCharged = {
  ...position,
  jobId: 1n,
  token: address('2'),
  worker: address('3'),
  creator: address('4'),
  amount: 100n,
  bonusPart: 40n,
}
const first: TopUp = { ...position, block: 5n, jobId: 1n, contributor: address('5'), amount: 10n, bonus: 10n }
const second: TopUp = { ...position, block: 6n, jobId: 1n, contributor: fee.creator, amount: 30n, bonus: 40n }

test('prior-epoch top-ups share only the bonus fee; the original creator also earns its own top-up share', () => {
  expect(creatorWeights(fee, 1000n, [second, first])).toEqual([
    { account: fee.creator, usd: 600n },
    { account: first.contributor, usd: 100n },
    { account: fee.creator, usd: 300n },
  ])
})

test('incomplete history refuses instead of attributing contributor fees to the publisher', () => {
  expect(() => creatorWeights(fee, 1000n, [])).toThrow('missing')
  expect(() => creatorWeights(fee, 1000n, [second])).toThrow('incomplete')
  expect(() => creatorWeights({ ...fee, bonusPart: 101n }, 1000n, [first, second])).toThrow('invalid fee')
})

test('other holdings, jobs and post-settlement top-ups never change creator weights', () => {
  const inputs = [first, second, { ...first, holding: address('6') }, { ...first, jobId: 2n }, { ...first, block: 11n }]
  expect(creatorWeights(fee, 1000n, inputs)).toEqual(creatorWeights(fee, 1000n, [first, second]))
  expect(creatorWeights({ ...fee, bonusPart: 0n }, 1000n, [])).toEqual([{ account: fee.creator, usd: 1000n }])
})
