import { describe, expect, it } from 'vitest'
import * as sdk from '@sidequest/sdk'
import { encodeFunctionData } from 'viem'
import {
  freezePosting,
  loadPosting,
  postingPublish,
  savePosting,
  postingPolicyError,
  updatePostingPolicy,
} from './posting-funding.ts'
import { emptyJournal, readTxJournalDurable, txJournalKey } from './components/txJournal.ts'
import { guardedSnapshot } from './components/txOperation.ts'
import type { VaultIntentCheckpoint } from './vault-lock.ts'
import type { TxRequest } from './api.ts'

const d = sdk.deployment('monad-testnet')
const ctx: sdk.Ctx = {
  deployment: d,
  stack: sdk.stack(d, 'main'),
  publicClient: sdk.context('monad-testnet', 'main', 'http://unit.invalid').publicClient,
}
const owner = '0x1111111111111111111111111111111111111111' as const
const hash = `0x${'11'.repeat(32)}` as const
const publish: TxRequest = {
  chainId: d.chainId,
  to: ctx.stack.holding,
  value: '0',
  description: 'Publish',
  data: encodeFunctionData({
    abi: sdk.sidequestHoldingAbi,
    functionName: 'publish',
    args: [
      {
        approver: owner,
        arbitrator: d.sidequest!.safe,
        token: d.rewardTokens[0]!,
        reward: 1n,
        creatorBond: 10n * 10n ** 18n,
        workerBond: 0n,
        manifestHash: sdk.EMPTY_HASH,
        policyHash: hash,
        deliveryDeadline: 2000,
        expiredAt: 2660,
        reviewWindow: 120,
        disputeWindow: 120,
        arbitrationWindow: 300,
      },
    ],
  }),
}
const plan = freezePosting(publish, {
  policy: {
    minimumCreatorBond: 10n * 10n ** 18n,
    treasury: d.sidequest!.safe,
    unfilledForfeitBps: 2500,
    cancelGrace: 600,
  },
  bondDeposit: 10n * 10n ** 18n,
  sideShortfall: 0n,
  transactions: [
    { ...publish, to: d.sidequest!.factory, data: '0x12345678', description: 'Approve backing' },
    { ...publish, to: d.sidequest!.vault, data: '0x87654321', description: 'Stake' },
    publish,
  ],
})
function store() {
  const local = new Map<string, string>(),
    durable = new Map<string, string | null>()
  return {
    local,
    durable,
    storage: {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => {
        local.set(key, value)
      },
      removeItem: (key: string) => {
        local.delete(key)
      },
    },
    checkpoint: {
      read: async (key) => durable.get(key),
      write: async (key, value) => {
        durable.set(key, value)
      },
    } satisfies VaultIntentCheckpoint,
  }
}
describe('reviewed posting recovery', () => {
  it('creates the inner journal before exposing the review and restores exact bytes on reload', async () => {
    const s = store()
    await savePosting(s.storage, 'funding', 'offer', plan, {
      journal: { ...emptyJournal(), batch: true },
      checkpoint: s.checkpoint,
    })
    expect(
      await readTxJournalDurable(s.storage, txJournalKey('offer', plan.transactions), true, s.checkpoint),
    ).toMatchObject({ batch: true, pending: null })
    s.local.clear()
    expect(await loadPosting(s.storage, 'funding', 'offer', publish, s.checkpoint)).toEqual(plan)
  })
  it('requires renewed policy review and preserves confirmed funding receipts', async () => {
    const s = store()
    const firstReceipt = `0x${'ab'.repeat(32)}` as const
    const journal = { ...emptyJournal(), hashes: [firstReceipt], recorded: [false] }
    await savePosting(s.storage, 'funding', 'offer', plan, { journal, checkpoint: s.checkpoint })
    const policy = {
      minimumCreatorBond: 10n * 10n ** 18n,
      unfilledForfeitBps: 5000,
      cancelGrace: 600,
      treasury: d.sidequest!.safe,
    }
    expect(postingPolicyError(plan, policy)).toContain('terms changed')
    const reviewed = updatePostingPolicy(plan, policy)
    expect(reviewed.transactions).toEqual(plan.transactions)
    await savePosting(s.storage, 'funding', 'offer', reviewed, { journal: emptyJournal(), checkpoint: s.checkpoint })
    expect(
      await readTxJournalDurable(s.storage, txJournalKey('offer', reviewed.transactions), true, s.checkpoint),
    ).toEqual(journal)
    expect(postingPolicyError(reviewed, policy)).toBeNull()
    expect(() => updatePostingPolicy(reviewed, { ...policy, minimumCreatorBond: 20n * 10n ** 18n })).toThrow(
      'at least 20 SIDE',
    )
  })
  it('fails closed for missing inner journals, altered offer, and uncommitted local review', async () => {
    const s = store()
    await savePosting(s.storage, 'funding', 'offer', plan, { journal: emptyJournal(), checkpoint: s.checkpoint })
    await expect(
      loadPosting(s.storage, 'funding', 'offer', { ...publish, data: '0x12345678' }, s.checkpoint),
    ).rejects.toThrow('differs')
    s.durable.delete(`sidequest.tx-journal:${txJournalKey('offer', plan.transactions)}`)
    await expect(loadPosting(s.storage, 'funding', 'offer', publish, s.checkpoint)).rejects.toThrow('durable record')
    s.durable.clear()
    await expect(loadPosting(s.storage, 'funding', 'offer', publish, s.checkpoint)).rejects.toThrow('durable record')
  })
  it('captures the funding nonce after a first-use wallet upgrade and rechecks expiry', async () => {
    let nonce = 7,
      now = 99
    const reads = { nonce: async () => nonce, blockNumber: async () => 10n }
    const guard = () => (now < 100 ? null : 'Expired')
    expect(
      await guardedSnapshot(reads, guard, async () => {
        nonce++
      }),
    ).toEqual({ nonce: 8, block: '10' })
    await expect(
      guardedSnapshot(reads, guard, async () => {
        nonce++
        now = 100
      }),
    ).rejects.toThrow('Expired')
  })
  it('selects only the publish selector from board approvals and refuses ambiguous offers', () => {
    expect(postingPublish(ctx, [{ ...publish, data: '0x12345678' }, publish])).toEqual(publish)
    expect(() => postingPublish(ctx, [publish, publish])).toThrow('exactly one')
  })
})
