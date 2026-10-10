import { parseAbiItem, type Address, type PublicClient } from './viem.ts'
import { pagedLogs } from './chain.ts'
import type { FeeCharged } from './compute.ts'
import { BACKER_SHARE_KEY, replayVaultEvents, resolveBackerWorkers, type VaultEventRecord } from './backers.ts'

export const metadataSetEvent = parseAbiItem(
  'event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)',
)
export const activatedEvent = parseAbiItem(
  'event Activated(uint256 indexed jobId, address indexed worker, uint256 agentId, uint256 selectionNonce, uint16 feeBps, uint256 fee, uint256 net, uint256 workerBond)',
)
export const stakeVaultEvents = [
  parseAbiItem(
    'event Delegated(address indexed account, address indexed delegator, address indexed payer, uint256 assets, uint256 shares)',
  ),
  parseAbiItem(
    'event UndelegateRequested(address indexed account, address indexed delegator, uint256 shares, uint256 assets, uint256 queuedShares, uint48 unlockAt)',
  ),
  parseAbiItem(
    'event UndelegateCancelled(address indexed account, address indexed delegator, uint256 shares, uint256 assets)',
  ),
  parseAbiItem('event Withdrawn(address indexed account, address indexed delegator, uint256 shares, uint256 assets)'),
  parseAbiItem('event PoolReset(address indexed account, uint64 generation)'),
  parseAbiItem('event Slashed(address indexed holding, address indexed account, uint256 amount)'),
  parseAbiItem('event Forfeited(address indexed holding, address indexed account, address indexed to, uint256 amount)'),
] as const

// SAFETY: Every caller supplies a decoded ABI address; changing case preserves its address shape.
const lower = (value: Address) => value.toLowerCase() as Address

async function vaultPositions(input: {
  c: PublicClient
  vault: Address
  deploymentBlock: bigint
  fromBlock: bigint
  toBlock: bigint
  page: bigint
}) {
  const { c, vault, deploymentBlock, fromBlock, toBlock, page } = input
  const logs = await pagedLogs(deploymentBlock, toBlock, page, (from, to) =>
    c.getLogs({ address: vault, events: stakeVaultEvents, fromBlock: from, toBlock: to, strict: true }),
  )
  const records: VaultEventRecord[] = logs.map((log) => {
    const base = { block: log.blockNumber, logIndex: log.logIndex, account: lower(log.args.account) }
    switch (log.eventName) {
      case 'Delegated':
      case 'Withdrawn':
        return { ...base, eventName: log.eventName, delegator: lower(log.args.delegator), shares: log.args.shares }
      case 'UndelegateRequested':
        return {
          ...base,
          eventName: log.eventName,
          delegator: lower(log.args.delegator),
          queuedShares: log.args.queuedShares,
        }
      case 'UndelegateCancelled':
        return { ...base, eventName: log.eventName, delegator: lower(log.args.delegator) }
      case 'PoolReset':
        return { ...base, eventName: log.eventName, generation: log.args.generation }
      case 'Slashed':
      case 'Forfeited':
        return { ...base, eventName: log.eventName }
    }
  })
  return replayVaultEvents(records, fromBlock, toBlock)
}

/** Historical eligibility uses logs only: Monad does not serve historical vault/registry eth_call state. */
export async function readBackerWorkers(input: {
  c: PublicClient
  identity: Address
  vault: Address
  holdings: Address[]
  fees: readonly FeeCharged[]
  deploymentBlock: bigint
  fromBlock: bigint
  toBlock: bigint
  page: bigint
}) {
  const { c, identity, vault, holdings, fees, deploymentBlock, fromBlock, toBlock, page } = input
  if (fees.length === 0 || fromBlock > toBlock) return []
  const [metadataLogs, activationLogs] = await Promise.all([
    // viem hashes the indexed string to keccak256(bytes(key)) when it builds the topics.
    pagedLogs(deploymentBlock, fromBlock - 1n, page, (from, to) =>
      c.getLogs({
        address: identity,
        event: metadataSetEvent,
        args: { indexedMetadataKey: BACKER_SHARE_KEY },
        fromBlock: from,
        toBlock: to,
        strict: true,
      }),
    ),
    pagedLogs(deploymentBlock, toBlock, page, (from, to) =>
      c.getLogs({ address: holdings, event: activatedEvent, fromBlock: from, toBlock: to, strict: true }),
    ),
  ])
  const metadata = metadataLogs.map((log) => ({
    block: log.blockNumber,
    logIndex: log.logIndex,
    tx: log.transactionHash,
    holding: lower(log.address),
    agentId: log.args.agentId,
    key: log.args.metadataKey,
    value: log.args.metadataValue,
  }))
  const activations = activationLogs.map((log) => ({
    block: log.blockNumber,
    logIndex: log.logIndex,
    tx: log.transactionHash,
    holding: lower(log.address),
    jobId: log.args.jobId,
    worker: lower(log.args.worker),
    agentId: log.args.agentId,
  }))
  const resolved = resolveBackerWorkers({ fees, metadata, activations, positions: [], fromBlock })
  if (!resolved.some((worker) => worker.bps > 0n)) return resolved
  const positions = await vaultPositions({ c, vault, deploymentBlock, fromBlock, toBlock, page })
  return resolveBackerWorkers({ fees, metadata, activations, positions, fromBlock })
}
