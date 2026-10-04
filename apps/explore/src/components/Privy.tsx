import * as sdk from '@agent-jobs/sdk'
import { PrivyProvider, useConnectWallet, useCreateWallet, usePrivy, useSign7702Authorization, useSigners, useWallets } from '@privy-io/react-auth'
import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from 'react'
import { type EIP1193Provider, type Hex, createPublicClient, http, toHex } from 'viem'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { type TxRequest, tool } from '../api.ts'
import { chain, deployment, privyAppId, setPrivyProvider } from '../wallet.ts'
import { Button } from './ui.tsx'
import { walletForAddress } from './agent-wallet-selection.ts'

interface AgentWallets {
  operatorAddress: string | undefined
  selectedAddress: string | undefined
  wallets: Array<{ address: string; id: string | undefined; embedded: boolean }>
  select(address: string): Promise<void>
  create(): Promise<{ address: string; id: string | undefined; accessToken: string }>
  accessToken(): Promise<string | null>
  connectExternal(): void
  removeSigners(address: string): Promise<void>
  busy: boolean
  error: string | null
}
const AgentWalletContext = createContext<AgentWallets | null>(null)
export const useAgentWallets = () => useContext(AgentWalletContext)

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
  blockExplorers: {
    default: chain.blockExplorers?.default ?? { name: 'Monadscan', url: 'https://monadscan.com' },
  },
}

export function PrivyRoot({ children }: { children: ReactNode }) {
  if (privyAppId === '') return children
  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        // Keep an operator wallet for the account; named agents use additional wallets or explicitly selected
        // external wallets. Logging in with a wallet never grants that wallet an agent's authority.
        embeddedWallets: { ethereum: { createOnLogin: 'all-users' } },
        defaultChain: privyChain,
        supportedChains: [privyChain],
      }}
    >
      <AgentWalletProvider>{children}</AgentWalletProvider>
    </PrivyProvider>
  )
}

/** Operator and named agent wallets are separate. A signer switch reconnects wagmi and invalidates its old account. */
function AgentWalletProvider({ children }: { children: ReactNode }) {
  const { authenticated, user, getAccessToken } = usePrivy()
  const { wallets } = useWallets()
  const { createWallet } = useCreateWallet()
  const { connectWallet: connectExternal } = useConnectWallet()
  const { removeSigners } = useSigners()
  const { address } = useAccount()
  const { connectors, connectAsync } = useConnect()
  const { disconnectAsync } = useDisconnect()
  const [selected, setSelected] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const liveAddress = useRef(address)
  liveAddress.current = address
  const pending = useRef(new Map<string, Promise<void>>())
  const queue = useRef<Promise<void>>(Promise.resolve())
  const primary = user?.linkedAccounts.find(
    (account) => account.type === 'wallet' && account.walletClientType === 'privy' && (account.walletIndex === 0 || account.walletIndex === null),
  )
  const operatorAddress = primary?.type === 'wallet' ? primary.address : user?.wallet?.address
  const wanted = selected ?? operatorAddress
  const current = walletForAddress(wallets, wanted)
  const connectWallet = (wallet: (typeof wallets)[number]): Promise<void> => {
    const key = wallet.address.toLowerCase()
    const existing = pending.current.get(key)
    if (existing !== undefined) return existing
    // The explicit switch and the automatic bridge effect share one serialized operation. A slow provider cannot
    // disconnect a newer signer or install the previous wallet while a second switch is in progress.
    const operation = queue.current
      .catch(() => {})
      .then(async () => {
        if (liveAddress.current?.toLowerCase() === key) return
        await wallet.switchChain(chain.id)
        const provider = (await wallet.getEthereumProvider()) as EIP1193Provider
        const connector = connectors.find((candidate) => candidate.id === 'privy')
        if (connector === undefined) throw new Error('The wallet connector is unavailable.')
        await disconnectAsync()
        setPrivyProvider(provider)
        await connectAsync({ connector })
        liveAddress.current = wallet.address as Hex
      })
      .finally(() => {
        pending.current.delete(key)
        setBusy(pending.current.size > 0)
      })
    pending.current.set(key, operation)
    queue.current = operation
    setBusy(true)
    return operation
  }
  useEffect(() => {
    if (!authenticated) {
      setSelected(undefined)
      setPrivyProvider(undefined)
      return
    }
    if (current === undefined || address?.toLowerCase() === current.address.toLowerCase()) return
    let cancelled = false
    void connectWallet(current).catch((failure: unknown) => {
      if (!cancelled) setError(failure instanceof Error ? failure.message : 'Wallet selection failed.')
    })
    return () => {
      cancelled = true
    }
  }, [authenticated, current?.address, address])
  return (
    <AgentWalletContext
      value={{
        operatorAddress,
        selectedAddress: address,
        wallets: wallets.map((wallet) => {
          const linked = user?.linkedAccounts.find((account) => account.type === 'wallet' && account.address.toLowerCase() === wallet.address.toLowerCase())
          return {
            address: wallet.address,
            id: linked?.type === 'wallet' ? (linked.id ?? undefined) : undefined,
            embedded: wallet.walletClientType === 'privy',
          }
        }),
        busy,
        error,
        select: async (next) => {
          const wallet = walletForAddress(wallets, next)
          if (wallet === undefined) throw new Error('This wallet is not connected. Connect it before choosing it.')
          setError(null)
          setSelected(wallet.address)
          await connectWallet(wallet)
        },
        create: async () => {
          if (!authenticated || operatorAddress === undefined) throw new Error('Sign in with your operator account first.')
          const wallet = await createWallet({ createAdditional: true })
          const token = await getAccessToken()
          if (token === null) throw new Error('Privy did not return a live ownership token. Sign in again.')
          return { address: wallet.address, id: wallet.id ?? undefined, accessToken: token }
        },
        accessToken: getAccessToken,
        connectExternal,
        removeSigners: async (walletAddress) => {
          const wallet = walletForAddress(wallets, walletAddress)
          if (wallet?.walletClientType !== 'privy')
            throw new Error('This managed wallet is not connected. Sign in to its Privy account to revoke its session signers.')
          await removeSigners({ address: wallet.address })
        },
      }}
    >
      {children}
    </AgentWalletContext>
  )
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
export type BatchSend = (txs: TxRequest[], gas?: bigint) => Promise<Hex>

export function usePrivyBatch(address: string | undefined): BatchSend | null {
  const account = useDelegatorAccount(address)
  if (account === null) return null
  return (txs, gas) => account.send(sdk.batchCalldata(txs.map((t) => ({ ...t, value: '0' as const }))), gas)
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
  /** A call to self, after the upgrade when it is still needed; `gas` when the calls need more than an estimate. */
  send(data: Hex, gas?: bigint): Promise<Hex>
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
  const embedded = walletForAddress(
    wallets.filter((wallet) => wallet.walletClientType === 'privy'),
    address,
  )
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
      authorization: {
        address: a.address,
        chainId: a.chainId,
        nonce: a.nonce,
        r: a.r,
        s: a.s,
        yParity: a.yParity,
      },
    })
    return r.txHash
  }
  return {
    delegated,
    upgrade,
    send: async (data, gas) => {
      await upgrade()
      const provider = (await embedded.getEthereumProvider()) as EIP1193Provider
      const request = {
        from: me,
        to: me,
        data,
        value: '0x0',
        chainId: toHex(chain.id),
        ...(gas === undefined ? {} : { gas: toHex(gas) }),
      }
      return (await provider.request({
        method: 'eth_sendTransaction',
        params: [request as never],
      })) as Hex
    },
  }
}
