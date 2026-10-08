/** Durable reviewed publish funding: stake enough SIDE backing, then approve the reward and publish. */
import * as sdk from '@sidequest/sdk'
import { decodeFunctionData, isAddress } from 'viem'
import type { TxRequest } from './api.ts'
import type { WalletStep } from './components/txOperation.ts'
import {
  readTxJournalDurable,
  writeTxJournalDurable,
  txJournalKey,
  type JournalStorage,
  type OpRecord,
} from './components/txJournal.ts'
import { browserVaultIntentCheckpoint, type VaultIntentCheckpoint } from './vault-lock.ts'

export interface FrozenPosting {
  publish: string
  transactions: WalletStep[]
  minimumBond: string
  deposit: string
  shortfall: string
  creatorBond: string
  unfilledForfeitBps: number
  cancelGrace: number
}

export function postingPublish(ctx: sdk.Ctx, txs: readonly TxRequest[]): TxRequest {
  const matches = txs.filter((tx) => {
    if (tx.to.toLowerCase() !== ctx.stack.holding.toLowerCase()) return false
    try {
      return decodeFunctionData({ abi: sdk.sidequestHoldingAbi, data: tx.data }).functionName === 'publish'
    } catch {
      return false
    }
  })
  if (matches.length !== 1) throw new Error('The offer must contain exactly one publish call')
  return matches[0]!
}

export function freezePosting(publish: TxRequest, plan: sdk.PublishFundingPlan): FrozenPosting {
  const decoded = decodeFunctionData({ abi: sdk.sidequestHoldingAbi, data: publish.data })
  if (decoded.functionName !== 'publish') throw new Error('Expected publish')
  return {
    publish: publish.data,
    transactions: plan.transactions.map((tx) => ({ ...tx, value: tx.value ?? '0' })),
    minimumBond: plan.policy.minimumCreatorBond.toString(),
    deposit: plan.bondDeposit.toString(),
    shortfall: plan.sideShortfall.toString(),
    creatorBond: decoded.args[0].creatorBond.toString(),
    unfilledForfeitBps: plan.policy.unfilledForfeitBps,
    cancelGrace: plan.policy.cancelGrace,
  }
}

/** Re-review policy without rebuilding or replaying any funding transaction. */
export function updatePostingPolicy(saved: FrozenPosting, policy: sdk.BondPolicy): FrozenPosting {
  sdk.requireCreatorBond(policy, BigInt(saved.creatorBond))
  return {
    ...saved,
    minimumBond: policy.minimumCreatorBond.toString(),
    unfilledForfeitBps: policy.unfilledForfeitBps,
    cancelGrace: policy.cancelGrace,
  }
}
export function postingPolicyError(saved: FrozenPosting, policy: sdk.BondPolicy): string | null {
  sdk.requireCreatorBond(policy, BigInt(saved.creatorBond))
  if (policy.unfilledForfeitBps !== saved.unfilledForfeitBps || policy.cancelGrace !== saved.cancelGrace)
    return 'The bond terms changed. Review the current bond terms before continuing.'
  return null
}

export async function loadPosting(
  storage: JournalStorage,
  key: string,
  taskId: string,
  publish: TxRequest,
  checkpoint: VaultIntentCheckpoint = browserVaultIntentCheckpoint,
): Promise<FrozenPosting | null> {
  const bytes = await checkpoint.read(key)
  if (bytes == null) {
    if (storage.getItem(key) !== null)
      throw new Error('Saved funding has no durable record. Reconcile before continuing.')
    return null
  }
  const saved: unknown = JSON.parse(bytes)
  if (
    !isFrozenPosting(saved) ||
    saved.publish !== publish.data ||
    saved.transactions.some((tx) => tx.chainId !== publish.chainId) ||
    saved.transactions.at(-1)?.data !== publish.data ||
    saved.transactions.at(-1)?.to.toLowerCase() !== publish.to.toLowerCase()
  )
    throw new Error('Saved funding plan is corrupt or differs from this offer. Reconcile before continuing.')
  await readTxJournalDurable(storage, txJournalKey(taskId, saved.transactions), true, checkpoint)
  return saved
}

export async function savePosting(
  storage: JournalStorage,
  key: string,
  taskId: string,
  plan: FrozenPosting,
  options: { journal: OpRecord; checkpoint?: VaultIntentCheckpoint },
): Promise<void> {
  const { journal, checkpoint = browserVaultIntentCheckpoint } = options
  const innerKey = txJournalKey(taskId, plan.transactions)
  if ((await readTxJournalDurable(storage, innerKey, false, checkpoint)) === null)
    await writeTxJournalDurable(storage, innerKey, journal, checkpoint)
  const bytes = JSON.stringify(plan)
  await checkpoint.write(key, bytes)
  storage.setItem(key, bytes)
  if (storage.getItem(key) !== bytes) throw new Error('Funding review could not be saved. No wallet prompt is allowed.')
}

function isWalletStep(value: unknown): value is WalletStep {
  return (
    value !== null &&
    typeof value === 'object' &&
    'chainId' in value &&
    typeof value.chainId === 'number' &&
    Number.isSafeInteger(value.chainId) &&
    'to' in value &&
    typeof value.to === 'string' &&
    isAddress(value.to) &&
    'data' in value &&
    typeof value.data === 'string' &&
    /^0x(?:[0-9a-f]{2})+$/i.test(value.data) &&
    'value' in value &&
    value.value === '0' &&
    'description' in value &&
    typeof value.description === 'string'
  )
}
function decimal(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value)
}
function isFrozenPosting(value: unknown): value is FrozenPosting {
  return (
    value !== null &&
    typeof value === 'object' &&
    'publish' in value &&
    typeof value.publish === 'string' &&
    'transactions' in value &&
    Array.isArray(value.transactions) &&
    value.transactions.length > 0 &&
    value.transactions.every(isWalletStep) &&
    'minimumBond' in value &&
    decimal(value.minimumBond) &&
    'deposit' in value &&
    decimal(value.deposit) &&
    'shortfall' in value &&
    decimal(value.shortfall) &&
    'creatorBond' in value &&
    decimal(value.creatorBond) &&
    'unfilledForfeitBps' in value &&
    typeof value.unfilledForfeitBps === 'number' &&
    Number.isInteger(value.unfilledForfeitBps) &&
    value.unfilledForfeitBps >= 0 &&
    value.unfilledForfeitBps <= 5000 &&
    'cancelGrace' in value &&
    typeof value.cancelGrace === 'number' &&
    Number.isSafeInteger(value.cancelGrace) &&
    value.cancelGrace > 0
  )
}
