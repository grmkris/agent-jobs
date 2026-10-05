import { expect, it } from 'vitest'
import { logWindowEnd, smallerLogSpan } from './log-ranges.ts'

it('VV2-004 retries shrinking inclusive windows and covers every block exactly once after success', () => {
  const start = 100n, through = 205n
  let from = start, span = 100n
  const covered: bigint[] = []
  const rejected: bigint[] = []
  while (from <= through) {
    const end = logWindowEnd(from, through, span)
    if (end - from + 1n > 25n) {
      rejected.push(from)
      span = smallerLogSpan(new Error('maximum block range is 25'), span)!
      continue
    }
    for (let block = from; block <= end; block++) covered.push(block)
    from = end + 1n
  }
  expect(rejected).toEqual([start, start])
  expect(covered).toEqual(Array.from({ length: 106 }, (_, i) => start + BigInt(i)))
  expect(smallerLogSpan(new Error('invalid credentials'), 100n)).toBeUndefined()
  expect(smallerLogSpan(new Error('query result limit'), 1n)).toBeUndefined()
})
