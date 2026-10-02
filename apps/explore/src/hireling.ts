/**
 * Hireling v1's protocol contracts on this deploy's network (ADR-0011; config `deployment.hireling`, decision D1):
 * FACTORY v2, the stake vault, the fee schedule, mining, the v1 Holding/Evaluator pair (the `main` stack) and the Safe
 * that owns them. Null until v1 is deployed here, and the pages that need them say so; nothing is read from a
 * placeholder. The one place that wires them, so the SDK's typed `hireling` block (B1) is a change to this file only.
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
  /** The owner of every v1 contract; null while the config does not record it. */
  safe: Address | null
}

type Block = Omit<HirelingContracts, 'holding' | 'evaluator' | 'safe'> & { safe?: Address }
const block = (deployment as { hireling?: Block | null }).hireling ?? null
const main = deployment.stacks.main

export const hireling: HirelingContracts | null =
  block === null || main === undefined ? null : { ...block, holding: main.holding, evaluator: main.evaluator, safe: block.safe ?? null }
