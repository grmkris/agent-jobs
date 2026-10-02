/**
 * The admin page's checks, before anything is signed: a fee schedule proposal against the rules `FeeSchedule.propose`
 * enforces (so the Safe never sends one that reverts), and the Merkle root inputs `EpochDistributor.setRoot` takes.
 * Pure, so they are unit-tested (admin.test.ts).
 */
import { type Address, isAddress, zeroAddress } from 'viem'
import { factoryAmount } from './stake.ts'

export interface ScheduleDraft {
  /** FACTORY, as typed. */
  thresholds: string[]
  /** Percent, as typed ("10", "2.5"). */
  rates: string[]
  treasury: string
}

/** Percent as typed, in basis points; null when it is not a number with at most two decimals. */
export function bpsOf(text: string): number | null {
  const t = text.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  return Math.round(Number(t) * 100)
}

/** The draft as `propose` takes it, or why it would be refused: the contract's rules, in its order. */
export function scheduleProposal(d: ScheduleDraft, maxBps: number): { thresholds: bigint[]; bps: number[]; treasury: Address } | string {
  const thresholds: bigint[] = []
  for (const [i, t] of d.thresholds.entries()) {
    const wei = i === 0 && t.trim() === '0' ? 0n : factoryAmount(t)
    if (wei === null) return `Tier ${i + 1}: enter a FACTORY threshold.`
    thresholds.push(wei)
  }
  const bps: number[] = []
  for (const [i, r] of d.rates.entries()) {
    const b = bpsOf(r)
    if (b === null) return `Tier ${i + 1}: enter a fee in percent, at most two decimals.`
    bps.push(b)
  }
  if (thresholds[0] !== 0n) return 'The first tier must start at 0 FACTORY, so every stake has a fee.'
  if (thresholds.some((t, i) => i > 0 && t <= (thresholds[i - 1] as bigint))) return 'Each tier must start above the one before it.'
  if (bps.some((b) => b > maxBps)) return `No tier may charge more than ${maxBps / 100} %.`
  if (bps.some((b, i) => i > 0 && b > (bps[i - 1] as number))) return 'A bigger stake may not pay a higher fee.'
  if (!isAddress(d.treasury.trim(), { strict: false }) || d.treasury.trim().toLowerCase() === zeroAddress) return 'Enter the treasury address that receives fees.'
  return { thresholds, bps, treasury: d.treasury.trim() as Address }
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/

/** `setRoot`'s inputs, or why they are not usable. */
export function rootProblem(input: { epoch: string; root: string; total: string; dataHash: string }): string | null {
  if (!/^\d+$/.test(input.epoch.trim())) return 'Enter the epoch number.'
  if (!BYTES32.test(input.root.trim())) return 'The root is 0x and 64 hex digits.'
  if (factoryAmount(input.total) === null) return 'Enter the epoch total in FACTORY.'
  if (!BYTES32.test(input.dataHash.trim())) return 'The data hash is 0x and 64 hex digits.'
  return null
}

/**
 * A new total for a posted root (`resizeRoot`), or why not. Only shrinking is offered here, to the leaf sum when the
 * posted total overstated it; the contract never lets a total drop below what is already claimed.
 */
export function resizeProblem(text: string, root: { total: bigint; claimed: bigint }): string | null {
  const total = /^0*\.?0*$/.test(text.trim()) && text.trim() !== '' && text.trim() !== '.' ? 0n : factoryAmount(text)
  if (total === null) return 'Enter the new total in FACTORY: the sum of the root’s leaves.'
  if (total >= root.total) return 'The new total must be below the posted one.'
  if (total < root.claimed) return 'The total cannot drop below what has already been claimed.'
  return null
}
