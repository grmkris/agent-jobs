/**
 * `/data/agents/<id>`: an ERC-8004 agent's public record here — the jobs it took and the jobs its wallets posted, its
 * money both ways and its timings — with each job's board. The agent's current wallet is read from the identity
 * registry so the jobs it posted from it count even before it took one.
 */
import { type AsyncSql, agentDetail } from '@agent-jobs/indexer'
import * as sdk from '@agent-jobs/sdk'
import { type Address, BaseError, ContractFunctionRevertedError, type PublicClient, zeroAddress } from 'viem'
import { boardsOfTerms } from '../registry.ts'

/** The identity registry reads the route needs; `undefined` when the chain is not configured. */
export interface IdentityReads {
  owner(agentId: bigint): Promise<Address>
  wallet(agentId: bigint): Promise<Address>
}

export function identityReads(client: Pick<PublicClient, 'readContract'>, identity: Address): IdentityReads {
  return {
    owner: (agentId) => client.readContract({ address: identity, abi: sdk.identityAbi, functionName: 'ownerOf', args: [agentId] }),
    wallet: (agentId) => client.readContract({ address: identity, abi: sdk.identityAbi, functionName: 'getAgentWallet', args: [agentId] }),
  }
}

const isRevert = (error: unknown) => error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError) !== null

/**
 * Whether the agent is registered (null: the registry did not answer in time) and its agent wallet (null when none
 * is set or unknown). A revert of `ownerOf` means no such agent; anything else is "unknown", never "not registered".
 */
export async function currentIdentity(reads: IdentityReads | undefined, agentId: bigint, timeoutMs = 2_000): Promise<{ registered: boolean | null; wallet: Address | null }> {
  if (reads === undefined) return { registered: null, wallet: null }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })
  const settled = Promise.allSettled([reads.owner(agentId), reads.wallet(agentId)])
  try {
    const result = await Promise.race([settled, timeout])
    if (result === 'timeout') return { registered: null, wallet: null }
    const [owner, wallet] = result
    const registered = owner.status === 'fulfilled' ? true : isRevert(owner.reason) ? false : null
    const address = registered === true && wallet.status === 'fulfilled' && wallet.value !== zeroAddress ? wallet.value : null
    return { registered, wallet: address }
  } finally {
    clearTimeout(timer)
  }
}

const NONE = { activeSince: null, lastActive: null, medianTurnaroundSeconds: null, turnarounds: 0 }

/** The route's JSON body: `ok` with a (possibly empty) record for a registered agent or one with jobs, else not-found. */
export async function agentDataBody(sql: AsyncSql, chainId: number, agentId: string, reads: IdentityReads | undefined) {
  const identity = await currentIdentity(reads, BigInt(agentId))
  const detail = await agentDetail(sql, chainId, agentId, identity.wallet === null ? [] : [identity.wallet])
  const meta = { registered: identity.registered, currentWallet: identity.wallet }
  if (detail === undefined) {
    if (identity.registered !== true) return { ok: false as const, code: 'not-found', message: 'this agent has no record here' }
    return {
      ok: true as const, ...meta,
      agent: { agentId, jobs: 0, completed: 0, inProgress: 0, lost: 0, earned: {}, feedback: {}, lastBlock: 0 },
      wallets: [], bonds: {}, jobs: [], feedback: [], posted: [],
      work: { earned: {} }, hiring: { posted: 0, open: 0, paidOut: {} }, time: NONE,
    }
  }
  const boards = await boardsOfTerms(sql, [...detail.jobs, ...detail.posted].map((j) => j.policy_hash)).catch(() => new Map<string, string>())
  const withBoard = <T extends { policy_hash: string | null }>(job: T) => ({ ...job, board_id: job.policy_hash === null ? null : (boards.get(job.policy_hash.toLowerCase()) ?? null) })
  return { ok: true as const, ...meta, ...detail, jobs: detail.jobs.map(withBoard), posted: detail.posted.map(withBoard) }
}
