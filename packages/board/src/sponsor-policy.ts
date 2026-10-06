import { RELAY_FLOOR_MAINNET, type Network } from '@sidequest/sdk'

/** Current funding policy keeps 2 MON on either chain, including G1's testnet relay. */
export const SPONSOR_RELAY_FLOORS: Readonly<Record<Network, bigint>> = {
  'monad-mainnet': RELAY_FLOOR_MAINNET,
  'monad-testnet': 2n * 10n ** 18n,
}
export const sponsorRelayFloor = (network: Network): bigint => SPONSOR_RELAY_FLOORS[network]

export const SPONSOR_LIMITS = {
  calls: 100, validity: 86400, batch: 8, walletCalls: 20, walletWindow: 3600, operatorPublishes: 100,
  dailyWei: 10n * 10n ** 18n, relayFloorWei: RELAY_FLOOR_MAINNET, gas: 6_000_000n,
} as const
