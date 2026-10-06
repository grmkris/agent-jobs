/**
 * Hireling v1's protocol contracts on this deploy's network (ADR-0011; config `deployment.hireling`, decision D1):
 * FACTORY v2, the stake vault, the fee schedule, mining, the v1 Holding/Evaluator pair (the `main` stack) and the Safe
 * that owns them. Before launch day `deployed` is false and every address here is zero: the pages that write are
 * gated and the chain transport sends nothing.
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
  /** The owner of every v1 contract and the core admin roles. */
  safe: Address
}

const { hireling: h, stacks: { main } } = deployment

export const hireling: HirelingContracts = { factory: h.factory, vault: h.vault, feeSchedule: h.feeSchedule, distributor: h.distributor, miningReserve: h.miningReserve, holding: main.holding, evaluator: main.evaluator, safe: h.safe }
