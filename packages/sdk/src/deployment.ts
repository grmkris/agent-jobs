/**
 * Addresses come from `contracts/config/<network>.json`, the file the deployment recipe writes; never from code
 * (AGENTS.md). One network, one core, and one Holding + evaluator pair per window set ("main", and on testnet
 * "demo" with minute-long windows).
 */
import type { Address } from 'viem'
import testnet from '../../../contracts/config/monad-testnet.json' with { type: 'json' }
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }

export type Network = 'monad-testnet' | 'monad-mainnet'
export type StackName = 'main' | 'demo'

export interface Stack {
  readonly holding: Address
  readonly evaluator: Address
}

export interface Deployment {
  readonly network: Network
  readonly chainId: number
  readonly core: Address
  readonly factory: Address
  /** Allowlisted reward tokens: the faucet tokens on testnet (`mUSD`, `mEUR`), USDC on mainnet. */
  readonly rewardTokens: readonly Address[]
  readonly stacks: Readonly<Partial<Record<StackName, Stack>>>
  /**
   * Earlier pairs replaced by a stacks-only redeploy (`script/DeployStacks.s.sol`), by name (`main-v1`): jobs
   * published on them stay there, so readers keep serving them. New offers go to `stacks` only.
   */
  readonly legacyStacks: Readonly<Record<string, Stack>>
  readonly identity: Address
  readonly reputation: Address
  /**
   * The EIP-7702 delegate a wallet points its code at to send a batch as one transaction: the canonical ERC-4337
   * v0.8 `Simple7702Account` (`executeBatch`, ERC-1271 by the account's own key), already deployed on Monad.
   */
  readonly batchDelegate: Address
  readonly arbitrator: Address
  readonly attester: Address
  readonly relay: Address
  /** The block the recipe deployed at: where an indexer starts and a rebuild restarts. */
  readonly deployBlock: bigint
}

interface ConfigFile {
  network: string
  chainId: number
  roles: { admin: string; relay: string; attester: string; arbitrator: string }
  erc8004: { identity: string; reputation: string }
  eip7702: { delegate: string; entryPoint: string }
  deployment: {
    block?: number
    core?: string
    factory?: string
    rewardTokens?: string[]
    main?: { holding: string; evaluator: string }
    demo?: { holding: string; evaluator: string }
    legacy?: Record<string, { holding: string; evaluator: string }>
  }
}

const files: Record<Network, ConfigFile> = {
  'monad-testnet': testnet as ConfigFile,
  'monad-mainnet': mainnet as ConfigFile,
}

export class NotDeployedError extends Error {
  constructor(network: Network) {
    super(`${network} has no deployment recorded in contracts/config/${network}.json`)
  }
}

/**
 * @param network Which network's recorded deployment to read.
 * @throws NotDeployedError when the recipe has not been run there.
 */
export function deployment(network: Network): Deployment {
  const c = files[network]
  const d = c.deployment
  if (d.core === undefined || d.factory === undefined || d.main === undefined) throw new NotDeployedError(network)
  const stacks: Partial<Record<StackName, Stack>> = {
    main: { holding: d.main.holding as Address, evaluator: d.main.evaluator as Address },
  }
  if (d.demo !== undefined) stacks.demo = { holding: d.demo.holding as Address, evaluator: d.demo.evaluator as Address }
  return {
    network,
    chainId: c.chainId,
    core: d.core as Address,
    factory: d.factory as Address,
    rewardTokens: (d.rewardTokens ?? []) as Address[],
    stacks,
    legacyStacks: Object.fromEntries(
      Object.entries(d.legacy ?? {}).map(([name, s]) => [name, { holding: s.holding as Address, evaluator: s.evaluator as Address }]),
    ),
    identity: c.erc8004.identity as Address,
    reputation: c.erc8004.reputation as Address,
    batchDelegate: c.eip7702.delegate as Address,
    arbitrator: c.roles.arbitrator as Address,
    attester: c.roles.attester as Address,
    relay: c.roles.relay as Address,
    deployBlock: BigInt(d.block ?? 0),
  }
}

/**
 * @param d A deployment.
 * @param name The window set.
 * @throws Error when that stack is not deployed on this network (mainnet has no "demo").
 */
export function stack(d: Deployment, name: StackName): Stack {
  const s = d.stacks[name]
  if (s === undefined) throw new Error(`${d.network} has no "${name}" stack`)
  return s
}

/** Every pair on the network, current and legacy, by name: what a reader of past jobs must know. */
export function allStacks(d: Deployment): Array<[name: string, stack: Stack]> {
  const out: Array<[string, Stack]> = []
  for (const [name, s] of Object.entries(d.stacks)) if (s !== undefined) out.push([name, s])
  for (const [name, s] of Object.entries(d.legacyStacks)) out.push([name, s])
  return out
}

/** The pair (current or legacy) whose Holding is `holding`, with its name; undefined for an unknown address. */
export function stackByHolding(d: Deployment, holding: string): [name: string, stack: Stack] | undefined {
  return allStacks(d).find(([, s]) => s.holding.toLowerCase() === holding.toLowerCase())
}
