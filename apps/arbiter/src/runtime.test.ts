import * as sdk from '@agent-jobs/sdk'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { type PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { arbiterAccounts, sendFundedCancellation } from './runtime.ts'

const oldKey = generatePrivateKey(), v1Key = generatePrivateKey()
const old = privateKeyToAccount(oldKey), v1 = privateKeyToAccount(v1Key)
const d = sdk.deployment('monad-testnet')
const legacyOnly: sdk.Deployment = { ...d, stacks: { main: d.legacyStacks['main-v3']! }, legacyStacks: {}, hireling: null }
const v1Only: sdk.Deployment = { ...d, network: 'monad-mainnet', chainId: 143, stacks: { main: { ...d.stacks.main!, kind: 'hireling-v1' } }, legacyStacks: {} }
const cancellationFixture = (account: typeof v1, chainId: number, balance = 240_000n) => {
  const send = vi.fn(async () => sdk.hashText('cancellation'))
  const wallet = { account, chain: { id: chainId }, sendTransaction: send } as unknown as sdk.Wallet
  const reads = { getChainId: async () => chainId, estimateGas: async () => 100_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    getBalance: vi.fn(async () => balance), waitForTransactionReceipt: async () => ({ status: 'success' }) } as unknown as PublicClient
  return { wallet, reads, send }
}

describe('arbiter runtime keys', () => {
  it('v1-only mainnet never reads or requires the old legacy secret', () => {
    expect(arbiterAccounts(v1Only, { V1_ARBITRATOR_PRIVATE_KEY: v1Key }).map(a => a.address)).toEqual([v1.address])
    expect(arbiterAccounts(v1Only, { V1_ARBITRATOR_PRIVATE_KEY: v1Key, ARBITRATOR_PRIVATE_KEY: 'unset' }).map(a => a.address)).toEqual([v1.address])
    expect(() => arbiterAccounts(v1Only, { ARBITRATOR_PRIVATE_KEY: oldKey })).toThrow('V1_ARBITRATOR_PRIVATE_KEY is not set')
  })
  it('legacy-only and mixed deployments require exactly their present key families', () => {
    expect(arbiterAccounts(legacyOnly, { ARBITRATOR_PRIVATE_KEY: oldKey }).map(a => a.address)).toEqual([old.address])
    const mixed = { ...v1Only, legacyStacks: { old: legacyOnly.stacks.main! } }
    expect(arbiterAccounts(mixed, { ARBITRATOR_PRIVATE_KEY: oldKey, V1_ARBITRATOR_PRIVATE_KEY: v1Key }).map(a => a.address)).toEqual([old.address, v1.address])
    expect(() => arbiterAccounts(mixed, { V1_ARBITRATOR_PRIVATE_KEY: v1Key })).toThrow('ARBITRATOR_PRIVATE_KEY is not set')
  })
  it('invalid keys never appear in an error, and duplicate accounts sign in once', () => {
    expect(() => arbiterAccounts(v1Only, { V1_ARBITRATOR_PRIVATE_KEY: 'private-value' })).toThrow('V1_ARBITRATOR_PRIVATE_KEY is invalid')
    const mixed = { ...v1Only, legacyStacks: { old: legacyOnly.stacks.main! } }
    expect(arbiterAccounts(mixed, { ARBITRATOR_PRIVATE_KEY: v1Key, V1_ARBITRATOR_PRIVATE_KEY: v1Key })).toHaveLength(1)
  })
})

describe('funded cancellation sender', () => {
  const tx: sdk.TxRequest = { to: v1Only.stacks.main!.evaluator, chainId: 143, data: '0x1234', value: '0', description: 'Cancel' }
  it('checks the selected account pending balance and pins the estimated gas/fee reserve', async () => {
    const f = cancellationFixture(v1, 143)
    await sendFundedCancellation(f.wallet, f.reads, tx)
    expect(f.reads.getBalance).toHaveBeenCalledWith({ address: v1.address, blockTag: 'pending' })
    expect(f.send).toHaveBeenCalledWith({ to: tx.to, data: tx.data, value: 0n, gas: 120_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n })
  })
  it('unfunded and wrong-chain cancellations never broadcast', async () => {
    const f = cancellationFixture(v1, 143, 239_999n)
    await expect(sendFundedCancellation(f.wallet, f.reads, tx)).rejects.toThrow('Fund the arbitrator cancellation gas reserve')
    expect(f.send).not.toHaveBeenCalled()
    await expect(sendFundedCancellation(f.wallet, f.reads, { ...tx, chainId: 10143 })).rejects.toThrow('chain/value refused')
    expect(f.send).not.toHaveBeenCalled()
  })
})
