/**
 * Gas limits for the Hireling v1 calls that push payouts (ADR-0011 "Gas", decision D4). Their contracts require a
 * fixed gas reserve per push and revert with `TransferGasTooLow` below it, and an estimate does not know that, so these
 * calls go out with at least the measured limit. Monad charges the gas limit, so the floor applies only to calls to the
 * v1 Holding and Evaluator, never to legacy contracts that share a function name. Pure (gas.test.ts).
 */
import * as sdk from '@agent-jobs/sdk'
import { type Abi, type Hex, decodeFunctionData } from 'viem'

const FLOORS: ReadonlyArray<{ contract: 'holding' | 'evaluator'; abi: Abi; limits: Record<string, bigint> }> = [
  { contract: 'holding', abi: sdk.hirelingHoldingAbi as Abi, limits: { settle: 1_000_000n, claimTopUpRefund: 450_000n } },
  { contract: 'evaluator', abi: sdk.hirelingEvaluatorAbi as Abi, limits: { accept: 1_100_000n, completeAfterSilence: 1_100_000n, rule: 1_100_000n, ruleWithSignature: 1_100_000n } },
]

/** A 7702 batch's own work on top of its calls' limits (the account's `execute` loop). */
export const BATCH_OVERHEAD = 100_000n

/**
 * The limit to send `tx` with: the larger of the one it names and the call's floor; undefined when neither applies
 * (the wallet estimates). `v1` is the deployment's v1 Holding and Evaluator, null before v1.
 */
export function gasLimit(tx: { to: string; data: Hex; gas?: string | undefined }, v1: { holding: string; evaluator: string } | null): bigint | undefined {
  const given = tx.gas === undefined ? undefined : BigInt(tx.gas)
  let floor: bigint | undefined
  for (const { contract, abi, limits } of FLOORS) {
    if (v1 === null || tx.to.toLowerCase() !== v1[contract].toLowerCase()) continue
    try {
      floor = limits[decodeFunctionData({ abi, data: tx.data }).functionName]
    } catch {
      // not a call this table knows
    }
  }
  if (given === undefined) return floor
  return floor !== undefined && floor > given ? floor : given
}

/** A batch's limit: its calls' limits plus the overhead, when any call has one; undefined lets the wallet estimate. */
export function batchGasLimit(txs: ReadonlyArray<{ to: string; data: Hex; gas?: string | undefined }>, v1: { holding: string; evaluator: string } | null): bigint | undefined {
  const limits = txs.map((tx) => gasLimit(tx, v1))
  if (limits.every((l) => l === undefined)) return undefined
  return limits.reduce<bigint>((sum, l) => sum + (l ?? 0n), BATCH_OVERHEAD)
}
