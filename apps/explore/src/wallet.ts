import * as sdk from '@agent-jobs/sdk'
import type { Chain } from 'viem'
import { createConfig, http } from 'wagmi'
import { monad, monadTestnet } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

declare const __AGENT_JOBS_NETWORK__: sdk.Network

export const network: sdk.Network = typeof __AGENT_JOBS_NETWORK__ === 'string' ? __AGENT_JOBS_NETWORK__ : 'monad-testnet'
export const isMainnet = network === 'monad-mainnet'

/** The deploy's chain; testnet with the explorer overridden (the chain's default testnet explorer entry is stale). */
export const chain: Chain = isMainnet
  ? monad
  : { ...monadTestnet, blockExplorers: { default: { name: 'Monadscan', url: 'https://testnet.monadscan.com' } } }

export const deployment = sdk.deployment(network)

export const wagmiConfig = createConfig({
  chains: [chain] as [Chain],
  connectors: [injected()],
  transports: { [chain.id]: http() },
})

export const explorer = (kind: 'tx' | 'address', value: string) => `${chain.blockExplorers?.default.url ?? ''}/${kind}/${value}`
