import * as sdk from '@agent-jobs/sdk'
import { type Abi, encodeFunctionData } from 'viem'
import { describe, expect, it } from 'vitest'
import { type CollectAction, type MiningClaimContext, readMiningClaim } from './collect.ts'

const W = 10n ** 18n
const me = '0x1111111111111111111111111111111111111111'
const other: `0x${string}` = '0x2222222222222222222222222222222222222222'
const distributor: `0x${string}` = '0x00000000000000000000000000000000000000d5'
const ctx: MiningClaimContext = { chainId: 10143, distributor, wallet: me }
const claim = (epoch: bigint, account: string, amount: bigint) =>
  encodeFunctionData({ abi: sdk.epochDistributorAbi as Abi, functionName: 'claim', args: [epoch, account, amount, [`0x${'aa'.repeat(32)}`]] })
const row = (patch: Partial<CollectAction> = {}, data: `0x${string}` = claim(0n, me, 1234n * W), to = distributor): CollectAction => ({
  kind: 'miningClaim', epoch: '0', token: '0x00000000000000000000000000000000000000f1', amount: (1234n * W).toString(),
  description: 'Claim work mining into your FACTORY stake.', transactions: [{ description: 'Claim', chainId: 10143, to, data, value: '0', gas: '500000' }], ...patch,
})

const problem = (r: CollectAction, c = ctx) => {
  const read = readMiningClaim(r, c)
  return read.ok ? null : read.problem
}

describe('a mining claim row', () => {
  it('reads back as the distributor’s claim for this wallet, epoch and amount', () => {
    expect(readMiningClaim(row(), ctx)).toEqual({ ok: true, epoch: 0n, amount: 1234n * W })
  })

  it('is refused when its calldata says something else than the row', () => {
    expect(problem(row({ epoch: null }))).toMatch(/no epoch or amount/)
    expect(problem(row({ amount: '0' }))).toMatch(/no epoch or amount/)
    expect(problem(row({ transactions: [] }))).toMatch(/not one claim/)
    expect(problem(row({ transactions: [...row().transactions, ...row().transactions] }))).toMatch(/not one claim/)
    expect(problem(row({}, claim(0n, me, 1234n * W), other))).toMatch(/distributor/)
    expect(problem(row({ transactions: [{ ...row().transactions[0]!, chainId: 143 }] }))).toMatch(/distributor/)
    // The type says '0'; the board's JSON is not checked by it.
    expect(problem(row({ transactions: [{ ...row().transactions[0]!, value: '1' as '0' }] }))).toMatch(/distributor/)
    expect(problem(row({}, '0x01'))).toMatch(/distributor/)
    expect(problem(row({}, encodeFunctionData({ abi: sdk.epochDistributorAbi as Abi, functionName: 'available' })))).toMatch(/distributor/)
    expect(problem(row({}, claim(1n, me, 1234n * W)))).toMatch(/epoch or amount/)
    expect(problem(row({}, claim(0n, me, 1235n * W)))).toMatch(/epoch or amount/)
    expect(problem(row({}, claim(0n, other, 1234n * W)))).toMatch(/another wallet/)
  })
})
