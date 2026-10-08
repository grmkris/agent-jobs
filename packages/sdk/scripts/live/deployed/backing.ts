/** G1e preparation only; operator backing is funded manually through Explore. */
import { type Address, erc20Abi, formatUnits, parseAbi } from 'viem'
import * as sdk from '../../../src/index.ts'
import { Runtime } from './runtime.ts'

const bondAbi = parseAbi(['function minimumCreatorBond() view returns (uint256)'])

/** Read the live policy once, then retain the exact bond for this run. */
export async function creatorBond(runtime: Runtime): Promise<string> {
  const saved = runtime.run.get<string>('creator-bond')
  if (saved !== undefined) {
    if (runtime.run.get<bigint>('creator-bond-wei') === undefined) throw new Error('P8_CREATOR_BOND_JOURNAL_INCOMPLETE')
    return saved
  }
  const { chain } = runtime
  const [floor, decimals] = await Promise.all([
    chain.ctx.publicClient.readContract({
      address: chain.ctx.stack.holding,
      abi: bondAbi,
      functionName: 'minimumCreatorBond',
    }),
    chain.ctx.publicClient.readContract({
      address: chain.ctx.deployment.factory,
      abi: erc20Abi,
      functionName: 'decimals',
    }),
  ])
  if (floor <= 0n) throw new Error('P8_CREATOR_BOND_FLOOR_INVALID')
  runtime.run.freeze('creator-bond-wei', floor)
  return runtime.run.freeze('creator-bond', formatUnits(floor, decimals))
}

/** Four agent publishes (A03, two A04s, A07) need four floor bonds. */
export async function ensureAgentBacking(runtime: Runtime, operations: readonly string[]): Promise<void> {
  await creatorBond(runtime)
  const floor = runtime.run.get<bigint>('creator-bond-wei')
  if (floor === undefined) throw new Error('P8_CREATOR_BOND_JOURNAL_INCOMPLETE')
  const publishes = pendingPublishes(operations, (key) => runtime.run.get(`intent/${key}`) !== undefined)
  // Frozen intents must reconcile their original operation, even if its bond is
  // now reserved or forfeited. Never block receipt recovery on new funding.
  if (operations.length > 0 && publishes === 0) return
  const target = runtime.run.freeze('agent-backing-target', floor * 4n)
  const blockNumber = await runtime.chain.ctx.publicClient.getBlockNumber({ cacheTime: 0 })
  const [backing, position] = await Promise.all([
    sdk.getBacking(runtime.chain.ctx, runtime.agent.address, { blockNumber }),
    sdk.getPosition(runtime.chain.ctx, runtime.agent.address, runtime.agent.operator, { blockNumber }),
  ])
  // Setup uses the existing Back this agent UI. Its durable transaction journal
  // reconciles any interrupted deposit before the operator prepares another one.
  // A restart only reads the resulting position; it never submits a second deposit.
  assertAgentBacking(backing.available, position.activeValue, target, floor * BigInt(publishes))
}

/** Fixture creators keep their own position; the operator owns the agent's backing. */
export async function requireCreatorBacking(runtime: Runtime, address: Address): Promise<void> {
  await creatorBond(runtime)
  const floor = runtime.run.get<bigint>('creator-bond-wei')
  if (floor === undefined) throw new Error('P8_CREATOR_BOND_JOURNAL_INCOMPLETE')
  if ((await sdk.getBacking(runtime.chain.ctx, address)).available < floor)
    throw new Error('P8_FIXTURE_CREATOR_BACKING_REQUIRED')
}

/** Already reserved bonds count toward setup capital, but cannot fund another publish. */
export function assertAgentBacking(available: bigint, operatorActive: bigint, target: bigint, needed: bigint): void {
  if (operatorActive < target || available < needed) throw new Error('P8_OPERATOR_AGENT_BACKING_REQUIRED')
}

export function pendingPublishes(operations: readonly string[], hasIntent: (key: string) => boolean): number {
  return operations.filter((key) => !hasIntent(key)).length
}

export function assertCreatorBond(runtime: Runtime, actual: bigint): void {
  if (actual !== runtime.run.get<bigint>('creator-bond-wei')) throw new Error('P8_ATOMIC_CREATOR_BOND_CHANGED')
}
