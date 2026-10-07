/**
 * What a wallet can close or claim (U3), from the board's `collect_actions(wallet)` (B4): settlements, top-up refunds,
 * payments held as `owed`, core refunds, unstaked SIDE and mining rewards, each with the transactions that collect
 * it. Read here only, so the page and the tab badge share one query.
 */
import * as sdk from '@sidequest/sdk'
import { useQuery } from '@tanstack/react-query'
import { type Abi, decodeFunctionData } from 'viem'
import { type TxRequest, tool } from './api.ts'

export type CollectKind = 'settle' | 'claimTopUpRefund' | 'withdraw' | 'claimRefund' | 'stakeWithdraw' | 'miningClaim'

export interface CollectAction {
  kind: CollectKind
  /** The job a job action is about. */
  jobId?: string | null
  /** The mining epoch a claim is for. */
  epoch?: string | null
  /** What the wallet receives, when known: the token and its base units. */
  token?: string | null
  amount?: string | null
  /** One sentence about what collecting does. */
  description: string
  transactions: TxRequest[]
}

export function useCollectActions(wallet: string | undefined, signedIn: boolean) {
  return useQuery({
    queryKey: ['collect_actions', wallet?.toLowerCase()],
    queryFn: () => tool<CollectAction[]>('collect_actions', { wallet }),
    enabled: wallet !== undefined && signedIn,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  })
}

export interface MiningClaimContext {
  chainId: number
  /** This network's EpochDistributor. */
  distributor: string
  wallet: string
}

const uint = (text: string | null | undefined): bigint | null =>
  typeof text === 'string' && /^(0|[1-9]\d*)$/.test(text) ? BigInt(text) : null
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const no = (problem: string) => ({ ok: false as const, problem })

/**
 * A mining claim (B8b) read back from its calldata rather than taken from the board's words: one
 * `EpochDistributor.claim(epoch, account, amount, proof)` on this network's distributor, for the row's epoch and amount
 * and for this wallet. The distributor stakes the reward for the account the call names, so a claim naming another
 * wallet would spend your gas on theirs; a row that does not read so is not offered.
 */
export function readMiningClaim(
  a: CollectAction,
  ctx: MiningClaimContext,
): { ok: true; epoch: bigint; amount: bigint } | { ok: false; problem: string } {
  const epoch = uint(a.epoch)
  const amount = uint(a.amount)
  if (epoch === null || amount === null || amount === 0n) return no('The board gave no epoch or amount for it.')
  const [tx, ...more] = a.transactions
  if (tx === undefined || more.length > 0) return no('It is not one claim transaction.')
  if (tx.chainId !== ctx.chainId || !same(tx.to, ctx.distributor) || (tx.value ?? '0') !== '0')
    return no('It is not a claim on this network’s distributor.')
  let decoded
  try {
    decoded = decodeFunctionData({ abi: sdk.epochDistributorAbi as Abi, data: tx.data })
  } catch {
    return no('It is not a claim on this network’s distributor.')
  }
  if (decoded.functionName !== 'claim') return no('It is not a claim on this network’s distributor.')
  const [claimEpoch, account, claimAmount] = (decoded.args ?? []) as [bigint, string, bigint]
  if (claimEpoch !== epoch || claimAmount !== amount) return no('Its epoch or amount is not what the row says.')
  if (!same(account, ctx.wallet)) return no('It would stake the reward for another wallet.')
  return { ok: true, epoch, amount }
}
