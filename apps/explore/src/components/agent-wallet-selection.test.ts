import { describe, expect, it } from 'vitest'
import { walletForAddress } from './agent-wallet-selection.ts'

describe('explicit agent wallet selection', () => {
  const operator = { address: '0x1111111111111111111111111111111111111111', id: 'operator' }
  const worker = { address: '0x2222222222222222222222222222222222222222', id: 'worker' }
  it('finds the named agent instead of inheriting the operator at index zero', () => {
    expect(walletForAddress([operator, worker], worker.address.toUpperCase())).toBe(worker)
  })
  it('never falls back to the first wallet for a missing or unconnected signer', () => {
    expect(walletForAddress([operator, worker], undefined)).toBeUndefined()
    expect(walletForAddress([operator], worker.address)).toBeUndefined()
    expect(walletForAddress([], operator.address)).toBeUndefined()
  })
})
