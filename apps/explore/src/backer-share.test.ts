import { expect, it } from 'vitest'
import { shareLabel } from './backer-share.ts'

it.each([
  [0, 'None'],
  [1, '0.01 %'],
  [1234, '12.34 %'],
  [5000, '50 %'],
  [10000, '100 %'],
])('labels %s basis points as %s', (bps, label) => {
  expect(shareLabel(bps)).toBe(label)
})
