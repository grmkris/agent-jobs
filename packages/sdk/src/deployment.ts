/**
 * Addresses come from `contracts/config/<network>.json`, the file the deployment recipe writes; never from code
 * (AGENTS.md). One network, one core and the current Hireling pair. Readers also retain every legacy pair and
 * its own FACTORY token; legacy jobs never switch contracts when a new pair deploys.
 */
import type { Address } from 'viem'
import testnet from '../../../contracts/config/monad-testnet.json' with { type: 'json' }
import mainnet from '../../../contracts/config/monad-mainnet.json' with { type: 'json' }

export type Network = 'monad-testnet' | 'monad-mainnet'
export type StackName = 'main' | 'demo' | 'fast'
export type StackKind = 'legacy' | 'hireling-v1'

/** Deploy-time protocol clocks. Values are seconds unless the field name says otherwise. */
export interface HirelingClocks {
  readonly minReviewWindow: number
  readonly minDisputeWindow: number
  readonly minArbitrationWindow: number
  readonly unstakeDelay: number
  readonly holdingDelay: number
  readonly feeDelay: number
  readonly proposalGrace: number
  readonly epochZeroDuration: number
  readonly epochDuration: number
}

/** Production values used when an older deployment record has no clocks block. */
export const PRODUCTION_CLOCKS: HirelingClocks = Object.freeze({
  minReviewWindow: 3600, minDisputeWindow: 3600, minArbitrationWindow: 43200,
  unstakeDelay: 604800, holdingDelay: 691200, feeDelay: 259200, proposalGrace: 604800,
  epochZeroDuration: 259200, epochDuration: 604800,
})

/** The 14-day window ceilings stay compiled constants (D24). */
export const MAX_HIRELING_WINDOW = 14 * 86400

export function clocksFromConfig(value: HirelingClocks | undefined, chainId: number): HirelingClocks {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid Hireling clocks block')
  const clocks = { ...(value ?? PRODUCTION_CLOCKS) }
  for (const key of Object.keys(PRODUCTION_CLOCKS) as Array<keyof HirelingClocks>) {
    const seconds = clocks[key]
    const minimum = key.startsWith('epoch') ? 600 : key.startsWith('min') ? 1 : 60
    const maximum = key.startsWith('min') ? MAX_HIRELING_WINDOW : 2 ** 48 - 1
    if (!Number.isSafeInteger(seconds) || seconds < minimum || seconds > maximum) throw new Error(`Invalid Hireling clock ${key}`)
    if (chainId === 143 && seconds !== PRODUCTION_CLOCKS[key]) throw new Error(`Mainnet requires production clock ${key}`)
  }
  if (clocks.holdingDelay <= clocks.unstakeDelay) throw new Error('Hireling holdingDelay must exceed unstakeDelay')
  return clocks
}

export interface Stack {
  readonly kind: StackKind
  readonly factory: Address
  readonly holding: Address
  readonly evaluator: Address
  /**
   * Whether this pair's Holding is safe with any ERC-20 (ADR-0010: the reward must arrive in full, no re-entry, a
   * refused payout is owed). Pairs deployed before it take only known tokens through the board.
   */
  readonly openTokens: boolean
}

export interface HirelingDeployment {
  readonly block: bigint
  /** Owner Safe for every v1 contract and the core admin roles. */
  readonly safe: Address
  readonly factory: Address
  readonly vault: Address
  readonly feeSchedule: Address
  readonly distributor: Address
  readonly miningReserve: Address
  readonly teamVesting: Address
  /** Launch time, in Unix seconds, used for the mining epochs. */
  readonly t0: number
  readonly clocks?: HirelingClocks
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
  /** The v1 protocol contracts, or null before the v1 recipe has deployed. */
  readonly hireling: HirelingDeployment | null
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

export interface DeploymentConfig {
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
    hireling?: {
      block: number
      safe: string
      factory: string
      vault: string
      feeSchedule: string
      distributor: string
      miningReserve: string
      teamVesting: string
      t0: number
      clocks?: HirelingClocks
    }
    rewardTokens?: string[]
    poolFactory?: string
    main?: StackEntry
    demo?: StackEntry | null
    fast?: StackEntry | null
    legacy?: Record<string, StackEntry>
  }
}

interface StackEntry {
  kind?: StackKind
  factory?: string
  holding: string
  evaluator: string
  openTokens?: boolean
}

const validAddress = (value: unknown): value is Address => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value)

const stackOf = (s: StackEntry, fallbackFactory: string, mixed: boolean): Stack => {
  if (mixed && s.kind === undefined) throw new Error('Hireling deployment requires an explicit kind on every pair')
  const kind = s.kind === undefined ? 'legacy' : s.kind
  if (kind !== 'legacy' && kind !== 'hireling-v1') throw new Error('Unknown deployment stack kind')
  // Only pre-v1 legacy configurations may omit the per-pair FACTORY.
  const factory = !mixed && s.factory === undefined && kind === 'legacy' ? fallbackFactory : s.factory
  if (!validAddress(factory)) throw new Error('Deployment stack requires a FACTORY address')
  return { kind, factory, holding: s.holding as Address, evaluator: s.evaluator as Address, openTokens: s.openTokens === true }
}

const files: Record<Network, DeploymentConfig> = {
  'monad-testnet': testnet as DeploymentConfig,
  'monad-mainnet': mainnet as DeploymentConfig,
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
  return deploymentFromConfig(network, files[network])
}

/** Parse a recorded network config. This also lets offline readers use an archived config without changing it. */
export function deploymentFromConfig(network: Network, c: DeploymentConfig): Deployment {
  if (c.network !== network) throw new Error('Deployment config network mismatch')
  const d = c.deployment
  if (d.core === undefined || d.factory === undefined || d.main === undefined) throw new NotDeployedError(network)
  const mixed = d.hireling !== undefined
  if (mixed && d.main.kind !== 'hireling-v1') throw new Error('Hireling deployment requires a hireling-v1 main pair')
  const stacks: Partial<Record<StackName, Stack>> = { main: stackOf(d.main, d.factory, mixed) }
  if (d.demo != null) stacks.demo = stackOf(d.demo, d.factory, mixed)
  if (d.fast != null) stacks.fast = stackOf(d.fast, d.factory, mixed)
  const legacyStacks = Object.fromEntries(Object.entries(d.legacy ?? {}).map(([name, s]) => [name, stackOf(s, d.factory!, mixed)]))
  let hireling: HirelingDeployment | null = null
  if (d.hireling !== undefined) {
    const h = d.hireling
    for (const name of ['safe', 'factory', 'vault', 'feeSchedule', 'distributor', 'miningReserve', 'teamVesting'] as const) {
      if (!validAddress(h[name])) throw new Error(`Hireling deployment requires ${name}`)
    }
    if (!Number.isSafeInteger(h.block) || h.block < 0 || !Number.isSafeInteger(h.t0) || h.t0 <= 0) throw new Error('Hireling deployment requires block and launch time')
    const clocks = h.clocks === undefined ? undefined : clocksFromConfig(h.clocks, c.chainId)
    hireling = { block: BigInt(h.block), safe: h.safe as Address, factory: h.factory as Address, vault: h.vault as Address, feeSchedule: h.feeSchedule as Address,
      distributor: h.distributor as Address, miningReserve: h.miningReserve as Address, teamVesting: h.teamVesting as Address, t0: h.t0,
      ...(clocks === undefined ? {} : { clocks }) }
  }
  for (const s of [...Object.values(stacks), ...Object.values(legacyStacks)]) {
    if (s?.kind === 'hireling-v1' && (hireling === null || s.factory.toLowerCase() !== hireling.factory.toLowerCase())) throw new Error('Hireling stack requires its matching v1 deployment')
  }
  if (stacks.main?.kind === 'hireling-v1' && stacks.main.factory.toLowerCase() !== d.factory.toLowerCase()) throw new Error('Current Hireling FACTORY does not match deployment FACTORY')
  return {
    network,
    chainId: c.chainId,
    core: d.core as Address,
    factory: d.factory as Address,
    hireling,
    rewardTokens: (d.rewardTokens ?? []) as Address[],
    stacks,
    legacyStacks,
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
