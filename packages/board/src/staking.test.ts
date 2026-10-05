import { expect, it } from 'vitest'
import { positionFilters } from './staking.ts'

const wallet = '0x1111111111111111111111111111111111111111'
const account = '0x2222222222222222222222222222222222222222'

it('defaults owner reads to caller and permits public pool or intersection reads', () => {
  expect(positionFilters({}, wallet)).toEqual({ wallet })
  expect(positionFilters({ account }, wallet)).toEqual({ account })
  expect(positionFilters({ account, wallet })).toEqual({ account, wallet })
})

it('refuses malformed or absent discovery filters', () => {
  expect(() => positionFilters({})).toThrow('required')
  expect(() => positionFilters({ wallet: '' })).toThrow('wallet')
  expect(() => positionFilters({ account: 'agent' }, wallet)).toThrow('account')
})
