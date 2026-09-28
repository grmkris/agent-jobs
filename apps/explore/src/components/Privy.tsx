import { PrivyProvider, usePrivy, useSigners, useWallets } from '@privy-io/react-auth'
import { type ReactNode, useEffect } from 'react'
import type { EIP1193Provider } from 'viem'
import { useAccount, useConnect } from 'wagmi'
import { chain, privyAppId, setPrivyProvider } from '../wallet.ts'
import { Button } from './ui.tsx'

/**
 * Email or social login (whatever the Privy dashboard enables: email, Google, X…) with a Privy embedded wallet, for
 * people without a browser wallet. Privy only creates and
 * holds the wallet; the app treats it like any other wallet (SIWE board sign-in, the same transaction steps). Absent
 * when the deploy has no PRIVY_APP_ID.
 */
/** The deploy's chain in Privy's shape (its type is stricter than viem's about optional fields). */
const privyChain = {
  id: chain.id,
  name: chain.name,
  nativeCurrency: chain.nativeCurrency,
  rpcUrls: { default: { http: [...chain.rpcUrls.default.http] } },
  blockExplorers: { default: chain.blockExplorers?.default ?? { name: 'Monadscan', url: 'https://monadscan.com' } },
}

export function PrivyRoot({ children }: { children: ReactNode }) {
  if (privyAppId === '') return children
  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        defaultChain: privyChain,
        supportedChains: [privyChain],
      }}
    >
      <PrivyBridge />
      {children}
    </PrivyProvider>
  )
}

/** Once logged in, hands the embedded wallet's provider to wagmi and connects it. */
function PrivyBridge() {
  const { authenticated } = usePrivy()
  const { wallets } = useWallets()
  const { isConnected } = useAccount()
  const { connectors, connect } = useConnect()
  const embedded = wallets.find((w) => w.walletClientType === 'privy')
  useEffect(() => {
    if (!authenticated || embedded === undefined || isConnected) return
    let cancelled = false
    void (async () => {
      await embedded.switchChain(chain.id)
      setPrivyProvider((await embedded.getEthereumProvider()) as EIP1193Provider)
      const connector = connectors.find((c) => c.id === 'privy')
      if (!cancelled && connector !== undefined) connect({ connector })
    })()
    return () => {
      cancelled = true
    }
  }, [authenticated, embedded, isConnected, connectors, connect])
  return null
}

/** "Email / social" next to "Connect wallet"; renders nothing without Privy. */
export function PrivyLogin() {
  if (privyAppId === '') return null
  return <PrivyLoginButton />
}

function PrivyLoginButton() {
  const { ready, authenticated, login } = usePrivy()
  if (authenticated) return null
  return (
    <Button variant="outline" disabled={!ready} onClick={() => login()}>
      Email / social
    </Button>
  )
}

/** Logs out of Privy too when the user signs out (no-op without Privy). */
export function usePrivyLogout(): () => Promise<void> {
  if (privyAppId === '') return async () => {}
  // biome-ignore lint: the branch above is a build-time constant, so hook order never changes.
  const { authenticated, logout } = usePrivy()
  return async () => {
    if (authenticated) await logout()
  }
}

/**
 * What the execution budget (ADR-0005) needs from Privy in the browser: an access token for the board, and adding or
 * removing the board's signer on the embedded wallet. Null without Privy, or when the signed-in wallet is not the
 * user's Privy embedded wallet (a budget is granted only from that wallet).
 */
export interface PrivyBudget {
  getAccessToken: () => Promise<string>
  addSigner: (address: string, signerId: string, policyId: string) => Promise<void>
  removeSigners: (address: string) => Promise<void>
}

export function usePrivyBudget(address: string | undefined): PrivyBudget | null {
  if (privyAppId === '') return null
  // biome-ignore lint: the branch above is a build-time constant, so hook order never changes.
  return usePrivyBudgetInner(address)
}

function usePrivyBudgetInner(address: string | undefined): PrivyBudget | null {
  const { authenticated, getAccessToken } = usePrivy()
  const { wallets } = useWallets()
  const { addSigners, removeSigners } = useSigners()
  const embedded = wallets.find((w) => w.walletClientType === 'privy')
  if (!authenticated || embedded === undefined || address === undefined || embedded.address.toLowerCase() !== address.toLowerCase()) return null
  return {
    getAccessToken: async () => {
      const t = await getAccessToken()
      if (t === null) throw new Error('Privy session expired: log in again')
      return t
    },
    addSigner: async (a, signerId, policyId) => {
      await addSigners({ address: a, signers: [{ signerId, policyIds: [policyId] }] })
    },
    removeSigners: async (a) => {
      await removeSigners({ address: a })
    },
  }
}
