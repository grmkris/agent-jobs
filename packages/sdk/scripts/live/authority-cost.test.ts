import { describe, expect, it } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { keccak256 } from 'viem'
import type { FlowState } from '../../src/flow-journal.ts'
import { spentAndReserved } from './authority-cost.ts'

describe('P0 relay cost exposure', () => {
  it('frees unused mined fee reservations while retaining an unresolved operation at its signed cap', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const raw = await account.signTransaction({ type: 'eip1559', chainId: 10143, nonce: 0,
      to: account.address, value: 0n, gas: 100_000n, maxFeePerGas: 200n, maxPriorityFeePerGas: 2n })
    const sent = { raw, hash: keccak256(raw), nonce: 0, wallet: account.address }
    const state: FlowState = { binding: 'pure cost fixture', values: {}, sends: { first: sent, pending: sent } }
    expect(spentAndReserved(state)).toBe(40_000_000n)
    state.values['receipt/first'] = { gasUsed: 100_000n, effectiveGasPrice: 102n }
    expect(spentAndReserved(state)).toBe(30_200_000n)
    state.values['receipt/pending'] = { gasUsed: 100_000n, effectiveGasPrice: 199n }
    expect(spentAndReserved(state)).toBe(30_100_000n)
  })
})
