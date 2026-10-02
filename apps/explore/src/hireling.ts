/**
 * Hireling v1's protocol contracts on this deploy's network (ADR-0011; config `deployment.hireling`, decision D1):
 * FACTORY v2, the stake vault, the fee schedule and mining. Null until v1 is deployed here, and the pages that need
 * them say so; nothing is read from a placeholder. The one place that wires them, so the SDK's typed `hireling`
 * block (B1) is a change to this file only.
 */
import type { Address } from 'viem'
import { deployment } from './wallet.ts'

export interface HirelingContracts {
  factory: Address
  vault: Address
  feeSchedule: Address
  distributor: Address
  miningReserve: Address
}

export const hireling: HirelingContracts | null = (deployment as { hireling?: HirelingContracts | null }).hireling ?? null
