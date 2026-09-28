/**
 * Decoding: a raw log from one of our contracts becomes a job-scoped event with JSON-safe arguments. Only events
 * that name a `jobId` are kept; everything the indexer shows is folded from these.
 */
import * as sdk from '@agent-jobs/sdk'
import { type Abi, type Address, type Hex, decodeEventLog } from 'viem'

export interface RawLog {
  readonly block_number: number
  readonly log_index: number
  readonly transaction_hash: Hex
  readonly address: Address
  readonly topic0?: Hex | null
  readonly topic1?: Hex | null
  readonly topic2?: Hex | null
  readonly topic3?: Hex | null
  readonly data: Hex
}

export interface IndexedEvent {
  readonly chainId: number
  readonly contract: string
  readonly block: number
  readonly logIndex: number
  readonly txHash: string
  readonly jobId: string
  readonly name: string
  readonly args: Record<string, string | number | boolean>
}

export type Role = 'core' | 'holding' | 'evaluator'

/** Which ABI decodes which address, and which stack a Holding or evaluator belongs to. */
export interface Contracts {
  readonly chainId: number
  readonly roles: ReadonlyMap<string, { role: Role; stack: string | null }>
}

export function contractsOf(network: sdk.Network): Contracts {
  const d = sdk.deployment(network)
  const roles = new Map<string, { role: Role; stack: string | null }>([[d.core.toLowerCase(), { role: 'core', stack: null }]])
  // Legacy pairs too: jobs published before a stacks-only redeploy keep emitting there (same events and ABI).
  for (const [name, s] of sdk.allStacks(d)) {
    roles.set(s.holding.toLowerCase(), { role: 'holding', stack: name })
    roles.set(s.evaluator.toLowerCase(), { role: 'evaluator', stack: name })
  }
  return { chainId: d.chainId, roles }
}

const ABIS: Record<Role, Abi> = { core: sdk.coreAbi as Abi, holding: sdk.jobHoldingAbi as Abi, evaluator: sdk.jobsEvaluatorAbi as Abi }

const jsonSafe = (v: unknown): string | number | boolean => (typeof v === 'bigint' ? v.toString() : typeof v === 'number' || typeof v === 'boolean' ? v : String(v))

/** A decoded job event, or undefined for an unknown contract, an undecodable log or an event without a job. */
export function decode(contracts: Contracts, log: RawLog): IndexedEvent | undefined {
  const who = contracts.roles.get(log.address.toLowerCase())
  if (who === undefined) return undefined
  const topics = [log.topic0, log.topic1, log.topic2, log.topic3].filter((t): t is Hex => typeof t === 'string')
  if (topics.length === 0) return undefined
  let decoded: { eventName: string; args: unknown }
  try {
    decoded = decodeEventLog({ abi: ABIS[who.role], data: log.data, topics: topics as [Hex, ...Hex[]] }) as typeof decoded
  } catch {
    return undefined
  }
  const raw = (decoded.args ?? {}) as Record<string, unknown>
  if (raw.jobId === undefined) return undefined
  const args: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(raw)) args[k] = jsonSafe(v)
  return {
    chainId: contracts.chainId,
    contract: log.address.toLowerCase(),
    block: log.block_number,
    logIndex: log.log_index,
    txHash: log.transaction_hash,
    jobId: String(raw.jobId),
    name: decoded.eventName,
    args,
  }
}
