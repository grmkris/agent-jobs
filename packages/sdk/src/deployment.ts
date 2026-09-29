/**
 * Addresses come from `contracts/config/<network>.json`, the file the deployment recipe writes; never from code
 * (AGENTS.md). One network, one core, and one Holding + evaluator pair per window set ("main", and on testnet
 * "demo" with minute-long windows).
 */
import type { Address } from 'viem'
import testnet from '../../../contracts/config/monad-testnet.json' with { type: 'json' }
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }

export type Network = 'monad-testnet' | 'monad-mainnet'
export type StackName = 'main' | 'demo' | 'fast'

export interface Stack {
  readonly holding: Address
  readonly evaluator: Address
  /**
   * Whether this pair's Holding is safe with any ERC-20 (ADR-0010: the reward must arrive in full, no re-entry, a
   * refused payout is owed). Pairs deployed before it take only known tokens through the board.
   */
  readonly openTokens: boolean
}

/** The caveat enforcers an execution budget is built from (MetaMask's `…Enforcer` contracts, ADR-0009). */
export interface DelegationEnforcers {
  readonly erc20TransferAmount: Address
  readonly allowedCalldata: Address
  readonly valueLte: Address
  readonly allowedTargets: Address
  readonly allowedMethods: Address
  readonly limitedCalls: Address
  readonly timestamp: Address
}

export interface Delegation {
  readonly manager: Address
  readonly delegator: Address
  readonly enforcers: DelegationEnforcers
}

export interface Deployment {
  readonly network: Network
  readonly chainId: number
  readonly core: Address
  readonly factory: Address
  /**
   * Known reward tokens, which the apps list first: the faucet tokens and the config's `knownTokens` (testnet
   * `$CHOMP`, mainnet USDC). Not a gate: a reward may be any ERC-20 (ADR-0010).
   */
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
   * The MetaMask Delegation Framework (ERC-7710, v1.3.0) on this chain: the `DelegationManager` a worker redeems an
   * execution budget against, the `EIP7702StatelessDeleGatorImpl` every account points its EIP-7702 code at (it
   * batches through ERC-7579 `execute` and validates the account's own key through ERC-1271), and the caveat
   * enforcers a budget delegation is built from (ADR-0009).
   */
  readonly delegation: Delegation
  /** The core's admin (deployer EOA): pauses, upgrades and verifier registration. */
  readonly admin: Address
  /** `JobPoolFactory` (ADR-0007): pooled funding of one offer. Null where none is deployed. */
  readonly poolFactory: Address | null
  readonly arbitrator: Address
  readonly attester: Address
  readonly relay: Address
  /**
   * x402 on this chain: the EIP-3009 USDC and Monad's facilitator, where a worker pays paid APIs and tools from its
   * own wallet (funded by an advance). Null where none is recorded.
   */
  readonly x402: { readonly usdc: Address; readonly facilitator: string } | null
  /** The block the recipe deployed at: where an indexer starts and a rebuild restarts. */
  readonly deployBlock: bigint
}

interface ConfigFile {
  network: string
  chainId: number
  roles: { admin: string; relay: string; attester: string; arbitrator: string }
  erc8004: { identity: string; reputation: string }
  delegation: { manager: string; delegator: string; enforcers: Record<keyof DelegationEnforcers, string> }
  x402?: { usdc: string; facilitator: string }
  deployment: {
    block?: number
    core?: string
    factory?: string
    rewardTokens?: string[]
    poolFactory?: string
    main?: StackEntry
    demo?: StackEntry
    fast?: StackEntry
    legacy?: Record<string, StackEntry>
  }
}

interface StackEntry {
  holding: string
  evaluator: string
  openTokens?: boolean
}

const stackOf = (s: StackEntry): Stack => ({ holding: s.holding as Address, evaluator: s.evaluator as Address, openTokens: s.openTokens === true })

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
  const stacks: Partial<Record<StackName, Stack>> = { main: stackOf(d.main) }
  if (d.demo !== undefined) stacks.demo = stackOf(d.demo)
  if (d.fast !== undefined) stacks.fast = stackOf(d.fast)
  return {
    network,
    chainId: c.chainId,
    core: d.core as Address,
    factory: d.factory as Address,
    rewardTokens: (d.rewardTokens ?? []) as Address[],
    stacks,
    legacyStacks: Object.fromEntries(
      Object.entries(d.legacy ?? {}).map(([name, s]) => [name, stackOf(s)]),
    ),
    identity: c.erc8004.identity as Address,
    reputation: c.erc8004.reputation as Address,
    delegation: {
      manager: c.delegation.manager as Address,
      delegator: c.delegation.delegator as Address,
      enforcers: c.delegation.enforcers as DelegationEnforcers,
    },
    admin: c.roles.admin as Address,
    poolFactory: d.poolFactory === undefined ? null : (d.poolFactory as Address),
    arbitrator: c.roles.arbitrator as Address,
    attester: c.roles.attester as Address,
    relay: c.roles.relay as Address,
    x402: c.x402 === undefined ? null : { usdc: c.x402.usdc as Address, facilitator: c.x402.facilitator },
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
