import { type Address, type Hex, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { hirelingEvaluatorAbi, hirelingHoldingAbi, jobHoldingAbi } from './abi/index.ts'
import { accept, activate, cancel, claimTopUpRefund, hashText, publish, settleDeferred, type ActivationTerms, type Ctx, type Wallet, V1_GAS } from './actions.ts'
import { deployment } from './deployment.ts'
import type { Selection } from './typed-data.ts'

const creator = '0x1111111111111111111111111111111111111111' as Address
const worker = '0x2222222222222222222222222222222222222222' as Address
const holding = '0x3333333333333333333333333333333333333333' as Address
const evaluator = '0x4444444444444444444444444444444444444444' as Address
const oldFactory = '0x5555555555555555555555555555555555555555' as Address
const arbitrator = '0x6666666666666666666666666666666666666666' as Address
const terms: ActivationTerms = { creator, approver: creator, token: oldFactory, reward: 101n, creatorBond: 2n, workerBond: 3n,
  arbitrator, reviewWindow: 3600, disputeWindow: 7200, arbitrationWindow: 43200, deliveryDeadline: 2_000_000_000 }
const policyHash = hashText('offer')
const selection: Selection = { jobId: 7n, worker, agentId: 1n, termsHash: policyHash, activateBy: 1_900_000_000, nonce: 1n }
const txHash = `0x${'ab'.repeat(32)}` as Hex

function fixture(kind: 'legacy' | 'hireling-v1' = 'hireling-v1', over: Partial<ActivationTerms> = {}, available = 20n) {
  const events: string[] = []
  const signed: Array<{ message: Record<string, unknown> }> = []
  const simulated: Array<Record<string, unknown>> = []
  const sent: Array<Record<string, unknown>> = []
  const reads: Array<Record<string, unknown>> = []
  const ctx = { deployment: { ...deployment('monad-testnet'), hireling: { factory: oldFactory, vault: holding } },
    stack: { kind, factory: oldFactory, holding, evaluator, openTokens: true },
    publicClient: {
      readContract: async (r: Record<string, unknown>) => {
        reads.push(r)
        const name = String(r.functionName)
        events.push(name)
        switch (name) {
          case 'getListing': return { ...terms, ...over, policyHash, mode: 0, workerBondPosted: false, workerBondReserved: false }
          case 'quoteActivation': return [3000, 31n, 70n]
          case 'stakeOf': return available
          case 'reservedOf': return 0n
          case 'availableOf': return available
          case 'unstakeOf': return [0n, 0]
          case 'allowance': return 0n
          default: throw new Error(`unexpected read ${name}`)
        }
      },
      simulateContract: async (r: Record<string, unknown>) => { simulated.push(r); events.push(`simulate:${r.functionName}`); return { request: r } },
      waitForTransactionReceipt: async () => { events.push('receipt'); return { status: 'success', transactionHash: txHash, logs: [] } },
    },
  } as unknown as Ctx
  const wallet = { account: { address: worker },
    signTypedData: async (r: { message: Record<string, unknown> }) => { signed.push(r); events.push('sign'); return '0x11' },
    writeContract: async (r: Record<string, unknown>) => { sent.push(r); events.push(`send:${r.functionName}`); return txHash },
  } as unknown as Wallet
  return { ctx, wallet, events, signed, simulated, sent, reads }
}

describe('kind-aware activation', () => {
  it('signs the fresh chain net, including ceil rounding, after validating stake and the listing', async () => {
    const f = fixture()
    await activate(f.ctx, f.wallet, selection, '0x11', terms)
    expect(f.signed[0]?.message.amount).toBe(70n)
    expect(f.events.slice(f.events.indexOf('quoteActivation'), f.events.indexOf('simulate:activate'))).toEqual(['quoteActivation', 'sign'])
    expect(f.events.indexOf('availableOf')).toBeLessThan(f.events.indexOf('quoteActivation'))
    expect(f.reads.find(r => r.functionName === 'quoteActivation')?.args).toEqual([7n, worker])
    expect(f.sent[0]?.abi).toBe(hirelingHoldingAbi)
    expect(f.sent.some(r => r.functionName === 'approve')).toBe(false)
  })

  for (const [field, value] of Object.entries({ token: holding, arbitrator: holding, creator: holding, approver: holding,
    reward: 102n, creatorBond: 4n, workerBond: 4n, reviewWindow: 7200, disputeWindow: 3600, arbitrationWindow: 86400, deliveryDeadline: 2_000_000_001 })) {
    it(`refuses an independently changed ${field} before signing, even with the same policyHash`, async () => {
      const f = fixture('hireling-v1', { [field]: value })
      await expect(activate(f.ctx, f.wallet, selection, '0x11', terms)).rejects.toThrow(`Listing ${field}`)
      expect(f.signed).toHaveLength(0)
      expect(f.sent).toHaveLength(0)
    })
  }

  it('refuses missing accepted terms, a different hash and insufficient stake before signing', async () => {
    const f = fixture()
    await expect(activate(f.ctx, f.wallet, selection, '0x11')).rejects.toThrow('accepted offer terms')
    await expect(activate(f.ctx, f.wallet, { ...selection, termsHash: hashText('other') }, '0x11', terms)).rejects.toThrow('policy hash')
    const poor = fixture('hireling-v1', {}, 2n)
    await expect(activate(poor.ctx, poor.wallet, selection, '0x11', terms)).rejects.toThrow('Insufficient available stake')
    expect(poor.signed).toHaveLength(0)
    expect(poor.sent).toHaveLength(0)
  })

  it('legacy activation approves that pair\'s factory and signs the gross reward', async () => {
    const f = fixture('legacy')
    await activate(f.ctx, f.wallet, selection, '0x11')
    expect(f.signed[0]?.message.amount).toBe(101n)
    expect(f.reads.find(r => r.functionName === 'allowance')?.address).toBe(oldFactory)
    expect(f.sent[0]?.address).toBe(oldFactory)
    expect(f.sent[1]?.abi).toBe(jobHoldingAbi)
    expect(f.events).not.toContain('quoteActivation')
  })

  it('requires an explicit nonzero arbitrator before any publish approval', async () => {
    const f = fixture()
    const input = { ...terms, mode: 'hire' as const, manifestHash: policyHash, termsHash: policyHash }
    await expect(publish(f.ctx, f.wallet, { ...input, arbitrator: zeroAddress })).rejects.toThrow('explicit arbitrator')
    const { arbitrator: _arbitrator, ...missing } = input
    await expect(publish(f.ctx, f.wallet, missing)).rejects.toThrow('explicit arbitrator')
    expect(f.reads).toHaveLength(0)
    expect(f.sent).toHaveLength(0)
  })
})

describe('v1 payout limits and recovery ordering', () => {
  it('carries the measured gas floors through simulation and sending', async () => {
    const f = fixture()
    await accept(f.ctx, f.wallet, 7n)
    await cancel(f.ctx, f.wallet, 7n)
    await claimTopUpRefund(f.ctx, f.wallet, 7n)
    expect(f.simulated.map(r => r.gas)).toEqual([V1_GAS.evaluator, V1_GAS.cancel, V1_GAS.claimTopUpRefund])
    expect(f.sent.map(r => r.gas)).toEqual([V1_GAS.evaluator, V1_GAS.cancel, V1_GAS.claimTopUpRefund])
    expect(f.sent[0]?.abi).toBe(hirelingEvaluatorAbi)
  })

  it('waits for retryDeferred to be confirmed before it simulates and sends settle', async () => {
    const f = fixture()
    await settleDeferred(f.ctx, f.wallet, 7n)
    expect(f.events).toEqual(['simulate:retryDeferred', 'send:retryDeferred', 'receipt', 'simulate:settle', 'send:settle', 'receipt'])
    expect(f.sent.map(r => r.gas)).toEqual([300_000n, 1_000_000n])
  })
})
