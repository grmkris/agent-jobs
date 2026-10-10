import { stakeVaultAbi } from '../../packages/sdk/src/abi/stakeVault.ts'
import { feeScheduleAbi } from '../../packages/sdk/src/abi/feeSchedule.ts'
import { sidequestHoldingAbi } from '../../packages/sdk/src/abi/sidequestHolding.ts'
import { identityAbi } from '../../packages/sdk/src/abi/identity.ts'
import type { Deployment, SidequestDeployment } from '../../packages/sdk/src/deployment.ts'
import { BACKER_SHARE_KEY } from './backers.ts'
import { reserveAbi } from './chain.ts'
import type { FeeCharged } from './compute.ts'
import type { MiningLedger } from './ledger.ts'
import { lower } from './ledger-chain.ts'
import type { Address, PublicClient } from './viem.ts'

export interface IntegrityInput {
  c: PublicClient
  deployment: Deployment
  sidequest: SidequestDeployment
  holdings: Address[]
  head: bigint
  ledger: MiningLedger
  fees: readonly FeeCharged[]
  workers: readonly Address[]
  agentIds: readonly bigint[]
}
const mismatch = (label: string): never => {
  throw new Error(`integrity: ${label} differs from replay or config`)
}
const equalAmounts = (a: readonly bigint[], b: readonly bigint[]) =>
  a.length === b.length && a.every((value, i) => value === b[i])

async function checkPools(input: IntegrityInput) {
  const { c, sidequest: h, head: blockNumber, ledger } = input
  const total = await c.readContract({ address: h.vault, abi: stakeVaultAbi, functionName: 'totalAssets', blockNumber })
  const replayed = [...ledger.pools.values()].reduce((sum, pool) => sum + pool.assets, 0n)
  if (total !== replayed) mismatch('vault totalAssets')
  for (const worker of input.workers) {
    const actual = await c.readContract({
      address: h.vault,
      abi: stakeVaultAbi,
      functionName: 'poolOf',
      args: [worker],
      blockNumber,
    })
    const expected = ledger.poolOf(worker)
    if (
      actual.assets !== expected.assets ||
      actual.shares !== expected.shares ||
      actual.queuedShares !== expected.queued ||
      actual.generation !== expected.generation
    )
      mismatch(`poolOf(${worker})`)
  }
}

async function checkSchedule(input: IntegrityInput) {
  const { c, sidequest: h, head: blockNumber, ledger } = input
  const schedule = await c.readContract({
    address: h.feeSchedule,
    abi: feeScheduleAbi,
    functionName: 'schedule',
    blockNumber,
  })
  const expected = ledger.feeSchedules.at(-1)
  if (
    expected === undefined ||
    !equalAmounts(schedule.thresholds, expected.thresholds) ||
    !equalAmounts(schedule.bps.map(BigInt), expected.bps) ||
    lower(schedule.treasury) !== expected.treasury
  )
    mismatch('fee schedule')
}

async function checkMetadata(input: IntegrityInput) {
  const { c, deployment: d, head: blockNumber, ledger } = input
  for (const agentId of input.agentIds) {
    const actual = await c.readContract({
      address: d.identity,
      abi: identityAbi,
      functionName: 'getMetadata',
      args: [agentId, BACKER_SHARE_KEY],
      blockNumber,
    })
    const expected = ledger.shareSets.get(agentId)?.at(-1)?.value ?? '0x'
    if (actual.toLowerCase() !== expected.toLowerCase()) mismatch(`getMetadata(${agentId})`)
  }
}

async function checkListings(input: IntegrityInput) {
  for (const fee of input.fees) {
    const actual = await input.c.readContract({
      address: fee.holding,
      abi: sidequestHoldingAbi,
      functionName: 'getListing',
      args: [fee.jobId],
      blockNumber: input.head,
    })
    const activation = input.ledger.activationOf(fee.holding, fee.jobId)
    const bonus = input.ledger.bonusBefore(fee)
    if (
      actual.reward !== activation.fee + activation.net ||
      actual.fee !== activation.fee ||
      BigInt(actual.feeBps) !== activation.feeBps ||
      actual.bonus !== bonus ||
      lower(actual.worker) !== fee.worker
    )
      mismatch(`getListing(${fee.jobId})`)
  }
}

async function checkHoldingConfig(input: IntegrityInput) {
  const { c, sidequest: h, deployment: d, head: blockNumber } = input
  for (const address of input.holdings) {
    const actual = await Promise.all([
      c.readContract({ address, abi: sidequestHoldingAbi, functionName: 'feeSchedule', blockNumber }),
      c.readContract({ address, abi: sidequestHoldingAbi, functionName: 'vault', blockNumber }),
      c.readContract({ address, abi: sidequestHoldingAbi, functionName: 'identity', blockNumber }),
    ])
    const expected = [h.feeSchedule, h.vault, d.identity].map(lower)
    if (actual.some((value, i) => lower(value) !== expected[i])) mismatch(`holding config ${address}`)
  }
}

/** Check the complete replay at one finalized head, then refuse if reserve funding is still moving. */
export async function checkIntegrity(input: IntegrityInput): Promise<void> {
  await checkPools(input)
  await checkSchedule(input)
  await checkMetadata(input)
  await checkListings(input)
  await checkHoldingConfig(input)
  const { c, sidequest: h, head: blockNumber, ledger } = input
  const total = await c.readContract({
    address: h.miningReserve,
    abi: reserveAbi,
    functionName: 'totalFunded',
    blockNumber,
  })
  const sum = ledger.funding.reduce((value, record) => value + record.amount, 0n)
  if (total !== sum) mismatch('totalFunded')
  const latest = await c.readContract({ address: h.miningReserve, abi: reserveAbi, functionName: 'totalFunded' })
  if (latest !== total) throw new Error('integrity: reserve funding is not final yet')
}
