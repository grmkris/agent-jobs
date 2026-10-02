import * as sdk from '@agent-jobs/sdk'
import { type Chain, type EIP1193Provider, zeroAddress } from 'viem'
import { createConfig, custom, http, useReadContract } from 'wagmi'
import { monad, monadTestnet } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'
import { closeWrites } from './launch.ts'
import { MAINNET_LIVE } from './release.ts'

declare const __AGENT_JOBS_NETWORK__: sdk.Network
declare const __PRIVY_APP_ID__: string

/** Privy's public app id; empty hides the email/social sign-in. */
export const privyAppId: string = typeof __PRIVY_APP_ID__ === 'string' ? __PRIVY_APP_ID__ : ''

export const network: sdk.Network = typeof __AGENT_JOBS_NETWORK__ === 'string' ? __AGENT_JOBS_NETWORK__ : 'monad-testnet'
export const isMainnet = network === 'monad-mainnet'

/** Canonical origin of each network's Explore (the header's network switch links to the other one's root). */
export const NETWORK_ORIGINS = { 'monad-mainnet': 'https://hireling.xyz', 'monad-testnet': 'https://testnet.hireling.xyz' } as const
export { MAINNET_LIVE }

/** The deploy's chain; testnet with the explorer overridden (the chain's default testnet explorer entry is stale). */
export const chain: Chain = isMainnet
  ? monad
  : { ...monadTestnet, blockExplorers: { default: { name: 'Monadscan', url: 'https://testnet.monadscan.com' } } }

/** The network's contracts, or null before launch day promotes them (mainnet's `deployment` block is empty until then). */
function loadDeployment(): sdk.Deployment | null {
  try {
    return sdk.deployment(network)
  } catch (error) {
    if (error instanceof sdk.NotDeployedError) return null
    throw error
  }
}
const loaded = loadDeployment()
/** Whether this network has its contracts (U-MAINNET-EMPTY): false only on mainnet before launch day promotes them. */
export const deployed = loaded !== null
/**
 * The network's deployment. Before launch day it is a placeholder with no contracts, so module-level reads of it
 * stay harmless; `deployed` is false, writes stay closed and the chain transport below sends nothing.
 */
export const deployment: sdk.Deployment = loaded ?? undeployed()
function undeployed(): sdk.Deployment {
  const none = zeroAddress
  const enforcers = { erc20TransferAmount: none, allowedCalldata: none, valueLte: none, allowedTargets: none, allowedMethods: none, limitedCalls: none, timestamp: none }
  return {
    network, chainId: chain.id, core: none, factory: none, hireling: null, rewardTokens: [], stacks: {}, legacyStacks: {}, identity: none,
    reputation: none, delegation: { manager: none, delegator: none, enforcers }, admin: none, poolFactory: null, arbitrator: none, attester: none,
    relay: none, x402: null, deployBlock: 0n,
  }
}

/**
 * Whether this deploy may publish, take, stake, pay or administer anything (D16): always on testnet, on mainnet only
 * once `MAINNET_LIVE` is set and the contracts are deployed. Closed, the pages that write show "launching soon", the
 * board client refuses write tools and the wallet refuses to send or sign (`launch.ts`), whatever URL was opened.
 */
export const writesOpen = (!isMainnet || MAINNET_LIVE) && deployed

/**
 * The Privy embedded wallet (email or social login) as a wagmi connector: the same `injected` connector pointed at
 * the provider Privy hands out after login, so transactions and typed-data signing go through the same wagmi hooks
 * as a browser wallet. Set by `PrivyBridge` once the user is logged in.
 */
let privyProvider: EIP1193Provider | undefined
export const setPrivyProvider = (p: EIP1193Provider | undefined) => {
  privyProvider = p
}
export const privyConnector = injected({ target: { id: 'privy', name: 'Privy', provider: () => closeWrites(privyProvider, writesOpen) } })
/**
 * A browser wallet (`window.ethereum`) for the embedded widget only (`/embed/<board>?wallet=injected`, ADR-0008):
 * a host page that already has a wallet passes it through. Explore's own sign-in stays Privy only; nothing here
 * auto-connects.
 */
export const injectedConnector = writesOpen
  ? injected()
  : injected({ target: { id: 'injected', name: 'Browser wallet', provider: () => closeWrites((globalThis as { ethereum?: EIP1193Provider }).ethereum, false) } })

export const wagmiConfig = createConfig({
  chains: [chain] as [Chain],
  // Sign-in is Privy only (email or social login with an embedded wallet); the injected connector serves the widget.
  connectors: privyAppId === '' ? [injectedConnector] : [privyConnector, injectedConnector],
  // With no contracts deployed there is nothing to read: every chain request is refused here, none goes out.
  transports: { [chain.id]: deployed ? http() : custom({ request: () => Promise.reject(new Error('Hireling is not deployed on this network yet')) }) },
})

/** The core's pause flag (admin power, README Trust): while set, every core call reverts and the board hands out none. */
export function usePaused(): boolean {
  const { data } = useReadContract({ address: deployment.core, abi: sdk.coreAbi, functionName: 'paused', chainId: chain.id, query: { refetchInterval: 30_000, enabled: deployed } })
  return data === true
}

export const explorer = (kind: 'tx' | 'address', value: string) => `${chain.blockExplorers?.default.url ?? ''}/${kind}/${value}`
