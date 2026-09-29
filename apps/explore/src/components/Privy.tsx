import * as sdk from '@agent-jobs/sdk'
import { PrivyProvider, usePrivy, useSign7702Authorization, useWallets } from '@privy-io/react-auth'
import { type ReactNode, useEffect } from 'react'
import { type EIP1193Provider, type Hex, createPublicClient, http, toHex } from 'viem'
import { useAccount, useConnect } from 'wagmi'
import { type TxRequest, tool } from '../api.ts'
import { chain, deployment, privyAppId, setPrivyProvider } from '../wallet.ts'
import { Button } from './ui.tsx'

/**
 * The site's only sign-in: email or social login (whatever the Privy dashboard enables: email, Google, X…) with a
 * Privy embedded wallet. Privy creates and holds the wallet; the app uses it for SIWE board sign-in, transaction
 * steps (batched through EIP-7702, the upgrade relayed by the board) and granting an execution budget.
 * People fund it from their own wallets. Absent when the deploy has no PRIVY_APP_ID (the site is then read-only).
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
        // Every user gets an embedded wallet, including one who logs in with an external wallet: the site acts only
        // through the embedded wallet (PrivyBridge connects nothing else), so an external wallet is at most a login.
        embeddedWallets: { ethereum: { createOnLogin: 'all-users' } },
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

/** The only way in: Privy's login (email or social). Without a Privy app the site is read-only. */
export function PrivyLogin() {
  if (privyAppId === '') return <span className="text-xs text-label-3">read-only</span>
  return <PrivyLoginButton />
}

function PrivyLoginButton() {
  const { ready, authenticated, login } = usePrivy()
  if (authenticated) return null
  return (
    <Button disabled={!ready} onClick={() => login()}>
      Sign in
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
 * Several transactions as one from the Privy embedded wallet (EIP-7702): a call to ERC-7579 `execute` on the wallet
 * itself, once the wallet points at the deployment's DeleGator (the first batch upgrades it through the board's
 * relay). All or nothing, one confirmation. Null without Privy or for another wallet.
 */
export type BatchSend = (txs: TxRequest[]) => Promise<Hex>

export function usePrivyBatch(address: string | undefined): BatchSend | null {
  const account = useDelegatorAccount(address)
  if (account === null) return null
  return (txs) => account.send(sdk.batchCalldata(txs.map((t) => ({ ...t, value: '0' as const }))))
}

/**
 * Points the Privy embedded wallet's code at the deployment's DeleGator when it is not there yet: what a creator does
 * once before granting an execution budget. Resolves to the relay's transaction hash, or null when nothing had to be
 * sent. Null without Privy or for another wallet.
 */
export function useDelegatorUpgrade(address: string | undefined): (() => Promise<Hex | null>) | null {
  const account = useDelegatorAccount(address)
  if (account === null) return null
  return account.upgrade
}

const reads = createPublicClient({ chain, transport: http() })

interface DelegatorAccount {
  delegated(): Promise<boolean>
  /** The DeleGator upgrade when the code is not there yet: the relay's transaction hash, or null. */
  upgrade(): Promise<Hex | null>
  /** A call to self, after the upgrade when it is still needed. */
  send(data: Hex): Promise<Hex>
}

function useDelegatorAccount(address: string | undefined): DelegatorAccount | null {
  if (privyAppId === '') return null
  // biome-ignore lint: the branch above is a build-time constant, so hook order never changes.
  return useDelegatorAccountInner(address)
}

function useDelegatorAccountInner(address: string | undefined): DelegatorAccount | null {
  const { authenticated } = usePrivy()
  const { wallets } = useWallets()
  const { signAuthorization } = useSign7702Authorization()
  const embedded = wallets.find((w) => w.walletClientType === 'privy')
  if (!authenticated || embedded === undefined || address === undefined || embedded.address.toLowerCase() !== address.toLowerCase()) return null
  const me = embedded.address as Hex
  const delegate = deployment.delegation.delegator
  const delegated = async () => {
    const current = await sdk.delegationOf(reads, me)
    return current !== null && current.toLowerCase() === delegate.toLowerCase()
  }
  // Privy's embedded wallets run in Privy's TEE, whose transaction signing drops `authorizationList`: the wallet signs
  // the authorization (for its current nonce, since it does not send the transaction) and the board's relay sends it.
  const upgrade = async (): Promise<Hex | null> => {
    if (await delegated()) return null
    const nonce = await reads.getTransactionCount({ address: me, blockTag: 'pending' })
    const a = await signAuthorization({ contractAddress: delegate, chainId: chain.id, nonce }, { address: me })
    const r = await tool<{ txHash: Hex | null }>('upgrade_account', {
      authorization: { address: a.address, chainId: a.chainId, nonce: a.nonce, r: a.r, s: a.s, yParity: a.yParity },
    })
    return r.txHash
  }
  return {
    delegated,
    upgrade,
    send: async (data) => {
      await upgrade()
      const provider = (await embedded.getEthereumProvider()) as EIP1193Provider
      const request = { from: me, to: me, data, value: '0x0', chainId: toHex(chain.id) }
      return (await provider.request({ method: 'eth_sendTransaction', params: [request as never] })) as Hex
    },
  }
}

