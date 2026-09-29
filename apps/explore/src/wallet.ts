import * as sdk from '@agent-jobs/sdk'
import type { Chain } from 'viem'
import type { EIP1193Provider } from 'viem'
import { createConfig, http, useReadContract } from 'wagmi'
import { monad, monadTestnet } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

declare const __AGENT_JOBS_NETWORK__: sdk.Network
declare const __PRIVY_APP_ID__: string

/** Privy's public app id; empty hides the email/social sign-in. */
export const privyAppId: string = typeof __PRIVY_APP_ID__ === 'string' ? __PRIVY_APP_ID__ : ''

export const network: sdk.Network = typeof __AGENT_JOBS_NETWORK__ === 'string' ? __AGENT_JOBS_NETWORK__ : 'monad-testnet'
export const isMainnet = network === 'monad-mainnet'

/** Canonical origin of each network's Explore (the header's network switch links to the other one's root). */
export const NETWORK_ORIGINS = { 'monad-mainnet': 'https://hireling.xyz', 'monad-testnet': 'https://testnet.hireling.xyz' } as const
/** Until mainnet is deployed, the switch shows Mainnet as disabled ("soon"). */
export const MAINNET_LIVE = false

/** The deploy's chain; testnet with the explorer overridden (the chain's default testnet explorer entry is stale). */
export const chain: Chain = isMainnet
  ? monad
  : { ...monadTestnet, blockExplorers: { default: { name: 'Monadscan', url: 'https://testnet.monadscan.com' } } }

export const deployment = sdk.deployment(network)

/**
 * The Privy embedded wallet (email or social login) as a wagmi connector: the same `injected` connector pointed at
 * the provider Privy hands out after login, so transactions and typed-data signing go through the same wagmi hooks
 * as a browser wallet. Set by `PrivyBridge` once the user is logged in.
 */
let privyProvider: EIP1193Provider | undefined
export const setPrivyProvider = (p: EIP1193Provider | undefined) => {
  privyProvider = p
}
export const privyConnector = injected({ target: { id: 'privy', name: 'Privy', provider: () => privyProvider } })
/**
 * A browser wallet (`window.ethereum`) for the embedded widget only (`/embed/<board>?wallet=injected`, ADR-0008):
 * a host page that already has a wallet passes it through. Explore's own sign-in stays Privy only; nothing here
 * auto-connects.
 */
export const injectedConnector = injected()

export const wagmiConfig = createConfig({
  chains: [chain] as [Chain],
  // Sign-in is Privy only (email or social login with an embedded wallet); the injected connector serves the widget.
  connectors: privyAppId === '' ? [injectedConnector] : [privyConnector, injectedConnector],
  transports: { [chain.id]: http() },
})

/** The core's pause flag (admin power, README Trust): while set, every core call reverts and the board hands out none. */
export function usePaused(): boolean {
  const { data } = useReadContract({ address: deployment.core, abi: sdk.coreAbi, functionName: 'paused', chainId: chain.id, query: { refetchInterval: 30_000 } })
  return data === true
}

export const explorer = (kind: 'tx' | 'address', value: string) => `${chain.blockExplorers?.default.url ?? ''}/${kind}/${value}`
