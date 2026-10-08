import { RELAY_FLOOR_MAINNET, type Network } from '@sidequest/sdk'

/** Current funding policy keeps 2 MON on either chain, including G1's testnet relay. */
const SPONSOR_RELAY_FLOORS: Readonly<Record<Network, bigint>> = {
  'monad-mainnet': RELAY_FLOOR_MAINNET,
  'monad-testnet': 2n * 10n ** 18n,
}
export const sponsorRelayFloor = (network: Network): bigint => SPONSOR_RELAY_FLOORS[network]

/** The relay's daily spend and each operator's calls per window. Testnet MON has no value, so multi-bot test runs get
 * room (Kris, 8 Oct); mainnet keeps the launch budget until launch funding decides it. */
const SPONSOR_BUDGETS: Readonly<Record<Network, { readonly dailyWei: bigint; readonly walletCalls: number }>> = {
  'monad-mainnet': { dailyWei: 10n * 10n ** 18n, walletCalls: 20 },
  'monad-testnet': { dailyWei: 50n * 10n ** 18n, walletCalls: 150 },
}
export const sponsorBudget = (network: Network) => SPONSOR_BUDGETS[network]

export const SPONSOR_LIMITS = {
  calls: 100,
  validity: 86400,
  batch: 8,
  walletWindow: 3600,
  operatorPublishes: 100,
  relayFloorWei: RELAY_FLOOR_MAINNET,
  gas: 6_000_000n,
  // Relay sends' gas limit as a percentage of the estimate (plus 10k): Monad bills the whole limit, and transactionGas's
  // exact-limit simulation falls back to the protocol limit when a tight one cannot run.
  gasMargin: 110,
} as const
