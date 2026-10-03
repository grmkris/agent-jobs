/**
 * The SDK's EIP-712 hashing against the contracts deployed on Monad testnet: `selectionDigest` and `rulingDigest`
 * are views, so this is a real integration test with no transaction. Skipped without MONAD_TESTNET_RPC_URL.
 */
import { hashTypedData } from 'viem'
import { describe, expect, it } from 'vitest'
import { context } from './client.ts'
import { hashText } from './actions.ts'
import * as sdk from './index.ts'

const rpc = process.env.MONAD_TESTNET_RPC_URL
const live = rpc === undefined || rpc === '' ? describe.skip : describe

live('typed data matches the deployed contracts (monad-testnet)', () => {
  // describe.skip still evaluates this callback. Resolve contexts only in tests, and enumerate archived
  // pairs only when live reads are enabled; the promoted deployment has no current demo pair.
  const stackNames = rpc ? ['main', ...Object.keys(sdk.deployment('monad-testnet').legacyStacks)] : ['main']
  const ctxFor = (name: string) => name === 'main'
    ? context('monad-testnet', 'main', rpc ?? '')
    : sdk.contextFor('monad-testnet', sdk.deployment('monad-testnet').legacyStacks[name]!, rpc ?? '')
  for (const stackName of stackNames) {
    it(`Selection digest equals JobHolding.selectionDigest (${stackName})`, async () => {
      const ctx = ctxFor(stackName)
      const sel = {
        jobId: 7n,
        worker: '0x00000000000000000000000000000000000000a1',
        agentId: 42n,
        termsHash: hashText('terms'),
        activateBy: 1_900_000_000,
        nonce: 123n,
      } as const
      const local = hashTypedData({
        domain: sdk.holdingDomain(ctx.deployment.chainId, ctx.stack.holding),
        types: sdk.selectionTypes,
        primaryType: 'Selection',
        message: sel,
      })
      expect(await sdk.selectionDigest(ctx, sel)).toBe(local)
    })

    it(`Ruling digest equals JobsEvaluator.rulingDigest (${stackName})`, async () => {
      const ctx = ctxFor(stackName)
      const r = {
        jobId: 7n,
        forWorker: true,
        slashLoser: false,
        reasonHash: hashText('reason'),
        deadline: 1_900_000_000n,
        nonce: 9n,
      } as const
      const local = hashTypedData({
        domain: sdk.evaluatorDomain(ctx.deployment.chainId, ctx.stack.evaluator),
        types: sdk.rulingTypes,
        primaryType: 'Ruling',
        message: r,
      })
      expect(await sdk.rulingDigest(ctx, r)).toBe(local)
    })
  }

  it('the recorded deployment is live on chain', async () => {
    const ctx = context('monad-testnet', 'main', rpc ?? '')
    expect(await ctx.publicClient.getChainId()).toBe(10143)
    const listing = await ctx.publicClient.readContract({
      address: ctx.stack.holding,
      abi: ctx.stack.kind === 'hireling-v1' ? sdk.hirelingHoldingAbi : sdk.jobHoldingAbi,
      functionName: 'evaluator',
    })
    expect(listing).toBe(ctx.stack.evaluator)
  })
})

describe('offline', () => {
  it('EMPTY_HASH is keccak256 of empty bytes', async () => {
    const { keccak256 } = await import('viem')
    expect(keccak256('0x')).toBe(sdk.EMPTY_HASH)
  })
})
