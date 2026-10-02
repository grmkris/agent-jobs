/**
 * Hireling v1's protocol contracts on this deploy's network (ADR-0011; config `deployment.hireling`, decision D1):
 * FACTORY v2, the stake vault, the fee schedule, mining, the v1 Holding/Evaluator pair (the `main` stack) and the Safe
 * that owns them. Null until v1 is deployed here, and the pages that need them say so; nothing is read from a
 * placeholder. Read from the SDK's typed `deployment.hireling` (B1) and the v1 `main` stack, in this one place.
 */
import type { Address } from 'viem'
import { deployment } from './wallet.ts'

export interface HirelingContracts {
  factory: Address
  vault: Address
  feeSchedule: Address
  distributor: Address
  miningReserve: Address
  holding: Address
  evaluator: Address
  /** The owner of every v1 contract (the SDK requires it in a v1 config; null is kept for callers' guards). */
  safe: Address | null
}

const h = deployment.hireling
const main = deployment.stacks.main

export const hireling: HirelingContracts | null =
  h === null || main === undefined || main.kind !== 'hireling-v1'
    ? null
    : { factory: h.factory, vault: h.vault, feeSchedule: h.feeSchedule, distributor: h.distributor, miningReserve: h.miningReserve, holding: main.holding, evaluator: main.evaluator, safe: h.safe }
