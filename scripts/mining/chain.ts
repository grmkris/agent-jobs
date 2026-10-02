import { createPublicClient, http, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from './viem.ts'
import type { FeeCharged, OwedWithdrawn, PayoutOwed } from './compute.ts'

export const holdingEvents = [
  parseAbiItem('event FeeCharged(uint256 indexed jobId, address indexed token, address indexed worker, address creator, uint256 amount, uint256 bonusPart)'),
  parseAbiItem('event PayoutOwed(uint256 indexed jobId, address indexed to, address indexed token, uint256 amount)'),
  parseAbiItem('event OwedWithdrawn(address indexed to, address indexed token, uint256 amount)'),
] as const
const epochFunded = parseAbiItem('event EpochFunded(uint256 indexed epoch, uint256 amount, uint256 totalFunded)')

export const reserveAbi = parseAbi([
  'function epochStart(uint256 epoch) view returns (uint256)',
  'function epochEnd(uint256 epoch) view returns (uint256)',
  'function cumulativeBudget(uint256 epoch) view returns (uint256)',
  'function totalFunded() view returns (uint256)',
  'function fund(uint256 epoch, uint256 amount)',
])
export const distributorAbi = parseAbi(['function setRoot(uint256 epoch, bytes32 root, uint256 total, bytes32 dataHash)'])
const safeAbi = parseAbi(['function getOwners() view returns (address[])'])
const erc20Abi = parseAbi(['function decimals() view returns (uint8)'])

export const client = (rpc: string): PublicClient => createPublicClient({ transport: http(rpc, { retryCount: 3, timeout: 30_000 }) }) as PublicClient

/** The first block in [lo, hi] whose timestamp is at least `t`, or hi + 1 if none is. */
export async function firstBlockAtOrAfter(c: PublicClient, t: bigint, lo: bigint, hi: bigint): Promise<bigint> {
  let [left, right] = [lo, hi + 1n]
  while (left < right) {
    const mid = (left + right) / 2n
    const block = await c.getBlock({ blockNumber: mid })
    if (block.timestamp >= t) right = mid
    else left = mid + 1n
  }
  return left
}

/** eth_getLogs over [from, to] in pages; a page the RPC refuses is halved and retried, and grows back after. */
async function pagedLogs<T>(from: bigint, to: bigint, pageSize: bigint, fetch: (from: bigint, to: bigint) => Promise<T[]>): Promise<T[]> {
  if (pageSize < 1n) throw new Error('the page size must be at least one block')
  const out: T[] = []
  let page = pageSize
  for (let start = from; start <= to;) {
    const end = start + page - 1n < to ? start + page - 1n : to
    try {
      out.push(...await fetch(start, end))
      start = end + 1n
      if (page < pageSize) page *= 2n
    } catch (error) {
      if (page === 1n) throw error
      page /= 2n
    }
  }
  return out
}

const lower = (a: string) => a.toLowerCase() as Address
const chainOrder = (x: { block: bigint; logIndex: number }, y: { block: bigint; logIndex: number }) =>
  x.block === y.block ? x.logIndex - y.logIndex : x.block < y.block ? -1 : 1

export async function holdingLogs(c: PublicClient, holdings: Address[], from: bigint, to: bigint, page: bigint) {
  const logs = await pagedLogs(from, to, page, (fromBlock, toBlock) => c.getLogs({ address: holdings, events: holdingEvents, fromBlock, toBlock, strict: true }))
  const fees: FeeCharged[] = []
  const owed: PayoutOwed[] = []
  const withdrawals: OwedWithdrawn[] = []
  for (const log of logs) {
    const at = { block: log.blockNumber, logIndex: log.logIndex, tx: log.transactionHash as Hex, holding: lower(log.address) }
    if (log.eventName === 'FeeCharged') {
      fees.push({ ...at, jobId: log.args.jobId, token: lower(log.args.token), worker: lower(log.args.worker), creator: lower(log.args.creator), amount: log.args.amount })
    } else if (log.eventName === 'PayoutOwed') {
      owed.push({ ...at, jobId: log.args.jobId, to: lower(log.args.to), token: lower(log.args.token), amount: log.args.amount })
    } else {
      withdrawals.push({ ...at, to: lower(log.args.to), token: lower(log.args.token), amount: log.args.amount })
    }
  }
  return { fees: fees.toSorted(chainOrder), owed: owed.toSorted(chainOrder), withdrawals: withdrawals.toSorted(chainOrder) }
}

/**
 * `cumulativeBudget(n)` less what was funded for earlier epochs (EpochFunded logs), and what epoch n already has, all
 * at the finalized `head`. `fund` adds to what is there, so a funding transaction that is mined but not yet final would
 * otherwise be missed and funded twice (B8-SEC-004): refuse until `totalFunded` agrees at latest and at `head`, and
 * until the logs add up to it.
 */
export async function budgetOf(c: PublicClient, reserve: Address, epoch: bigint, deployBlock: bigint, head: bigint, page: bigint) {
  const cumulativeBudget = await c.readContract({ address: reserve, abi: reserveAbi, functionName: 'cumulativeBudget', args: [epoch] })
  const totalFunded = await c.readContract({ address: reserve, abi: reserveAbi, functionName: 'totalFunded', blockNumber: head })
  const totalFundedLatest = await c.readContract({ address: reserve, abi: reserveAbi, functionName: 'totalFunded' })
  if (totalFundedLatest !== totalFunded) throw new Error('a MiningReserve funding transaction is not final yet; wait for finality and run again')
  let fundedBefore = 0n
  let fundedThis = 0n
  if (totalFunded > 0n) {
    let sum = 0n
    const logs = await pagedLogs(deployBlock, head, page, (fromBlock, toBlock) => c.getLogs({ address: reserve, event: epochFunded, fromBlock, toBlock, strict: true }))
    for (const log of logs) {
      sum += log.args.amount
      if (log.args.epoch < epoch) fundedBefore += log.args.amount
      else if (log.args.epoch === epoch) fundedThis += log.args.amount
    }
    if (sum !== totalFunded) throw new Error(`the EpochFunded logs add up to ${sum}, but totalFunded() is ${totalFunded} at block ${head}`)
  }
  const available = cumulativeBudget > fundedBefore ? cumulativeBudget - fundedBefore : 0n
  return { cumulativeBudget, fundedBefore, fundedThis, totalFunded, available }
}

export async function safeOwners(c: PublicClient, safe: Address): Promise<Address[]> {
  return (await c.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' })).map(lower)
}

export async function decimalsOf(c: PublicClient, token: Address): Promise<number> {
  return await c.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
}
