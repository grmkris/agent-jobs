/**
 * A wallet's record on the board, as its page and card tell it: the work it posted and what became of that, the money
 * it paid out and still holds in escrow, the agents it hired, its open requests and the jobs it approves for someone
 * else. All of it is read from the jobs and requests Activity already holds; nothing here is private.
 */
import type { Bucket, FeedJob } from './activity-feed.ts'

/** An amount in one token's base units. */
export interface TokenSum {
  token: string
  value: string
}

export interface WalletRecord {
  /** Jobs it published on chain. */
  posted: number
  /** Of those, the ones that paid their agent. */
  paidJobs: number
  /** What those paid jobs cost it, per token. */
  paid: TokenSum[]
  /** What it holds for jobs still open, under way, in review or in dispute, per token. */
  escrow: TokenSum[]
  /** Jobs that closed without paying, the reward back with it. */
  refunded: number
  /** Jobs in dispute now. */
  disputes: number
  /** The agents it hired, the most hired first. */
  hired: { agentId: string; jobs: number }[]
  /** Its quote requests still taking quotes. */
  openRequests: FeedJob[]
  /** Jobs it approves on someone else's behalf. */
  approves: number
}

const HELD: ReadonlySet<Bucket> = new Set(['open', 'progress', 'review', 'disputes'])

const same = (a: string | null | undefined, wallet: string) => a != null && a.toLowerCase() === wallet

function add(sums: Map<string, bigint>, token: string | null, value: string | null) {
  if (token === null || value === null) return
  sums.set(token, (sums.get(token) ?? 0n) + BigInt(value))
}

const listed = (sums: Map<string, bigint>): TokenSum[] =>
  [...sums]
    .toSorted(([, a], [, b]) => (a === b ? 0 : a > b ? -1 : 1))
    .map(([token, value]) => ({ token, value: value.toString() }))

function hiredOf(posted: readonly FeedJob[]) {
  const counts = new Map<string, number>()
  for (const job of posted) if (job.workerAgent !== null) counts.set(job.workerAgent, (counts.get(job.workerAgent) ?? 0) + 1)
  return [...counts]
    .map(([agentId, jobs]) => ({ agentId, jobs }))
    .toSorted((a, b) => b.jobs - a.jobs || Number(a.agentId) - Number(b.agentId))
}

export function walletRecord(feed: readonly FeedJob[], address: string): WalletRecord {
  const wallet = address.toLowerCase()
  const posted = feed.filter((job) => job.item.chain !== undefined && same(job.item.chain.creator, wallet))
  const paid = new Map<string, bigint>()
  const escrow = new Map<string, bigint>()
  for (const { item, bucket } of posted) {
    const chain = item.chain
    if (chain === undefined || bucket === null) continue
    if (bucket === 'paid') add(paid, chain.token, chain.reward)
    else if (HELD.has(bucket)) add(escrow, chain.token, chain.reward)
  }
  return {
    posted: posted.length,
    paidJobs: posted.filter((job) => job.bucket === 'paid').length,
    paid: listed(paid),
    escrow: listed(escrow),
    refunded: posted.filter((job) => job.bucket === 'closed').length,
    disputes: posted.filter((job) => job.bucket === 'disputes').length,
    hired: hiredOf(posted),
    openRequests: feed.filter(
      (job) => job.item.jobId === null && job.bucket === 'open' && same(job.item.request?.creator, wallet),
    ),
    approves: feed.filter(
      (job) => job.item.chain !== undefined && same(job.item.chain.approver, wallet) && !same(job.item.chain.creator, wallet),
    ).length,
  }
}

/** Whether the record has anything to tell: a wallet that never posted, asked or approved has no history here. */
export const hasHistory = (r: WalletRecord): boolean => r.posted > 0 || r.openRequests.length > 0 || r.approves > 0
