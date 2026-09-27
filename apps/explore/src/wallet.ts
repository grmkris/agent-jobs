import * as sdk from '@agent-jobs/sdk'
import { createConfig, http } from 'wagmi'
import { monadTestnet } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

/** Monad testnet with the explorer overridden (the chain's default testnet explorer entry is stale). */
export const chain = {
  ...monadTestnet,
  blockExplorers: { default: { name: 'Monadscan', url: 'https://testnet.monadscan.com' } },
} as const

export const deployment = sdk.deployment('monad-testnet')

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected()],
  transports: { [chain.id]: http() },
})

export const explorer = (kind: 'tx' | 'address', value: string) => `${chain.blockExplorers.default.url}/${kind}/${value}`
