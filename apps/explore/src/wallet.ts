import * as sdk from '@agent-jobs/sdk'
import type { Chain } from 'viem'
import type { EIP1193Provider } from 'viem'
import { createConfig, http } from 'wagmi'
import { monad, monadTestnet } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

declare const __AGENT_JOBS_NETWORK__: sdk.Network
declare const __PRIVY_APP_ID__: string

/** Privy's public app id; empty hides the email/social sign-in. */
export const privyAppId: string = typeof __PRIVY_APP_ID__ === 'string' ? __PRIVY_APP_ID__ : ''

export const network: sdk.Network = typeof __AGENT_JOBS_NETWORK__ === 'string' ? __AGENT_JOBS_NETWORK__ : 'monad-testnet'
export const isMainnet = network === 'monad-mainnet'

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

export const wagmiConfig = createConfig({
  chains: [chain] as [Chain],
  connectors: [injected(), ...(privyAppId === '' ? [] : [privyConnector])],
  transports: { [chain.id]: http() },
})

export const explorer = (kind: 'tx' | 'address', value: string) => `${chain.blockExplorers?.default.url ?? ''}/${kind}/${value}`
