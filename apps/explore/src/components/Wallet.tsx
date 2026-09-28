import { type ReactNode, createContext, useContext, useState } from 'react'
import { useAccount, useConnect, useDisconnect, useSignMessage } from 'wagmi'
import { session, setSession, tool } from '../api.ts'
import { PrivyLogin, usePrivyLogout } from './Privy.tsx'
import { Address, Button } from './ui.tsx'

/** Connect an injected wallet, then sign in to the board with SIWE (one signature, no transaction). */
export function useSignedIn() {
  const { address } = useAccount()
  const [token, setToken] = useState(session())
  const { signMessageAsync } = useSignMessage()
  const signIn = async () => {
    if (address === undefined) throw new Error('connect a wallet first')
    const { message } = await tool<{ message: string }>('auth_challenge', { address })
    const signature = await signMessageAsync({ message })
    const { session: s } = await tool<{ session: string }>('auth_login', { message, signature })
    setSession(s)
    setToken(s)
  }
  const signOut = () => {
    setSession(null)
    setToken(null)
  }
  return { address, signedIn: token !== null && address !== undefined, signIn, signOut }
}

const AuthContext = createContext<ReturnType<typeof useSignedIn> | null>(null)

/** One sign-in state for the whole app (the header and every page see the same session). */
export function AuthProvider({ children }: { children: ReactNode }) {
  return <AuthContext value={useSignedIn()}>{children}</AuthContext>
}

export function useAuth() {
  const auth = useContext(AuthContext)
  if (auth === null) throw new Error('useAuth outside AuthProvider')
  return auth
}

export function WalletBar({ auth }: { auth: ReturnType<typeof useSignedIn> }) {
  const { connectors, connect, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const privyLogout = usePrivyLogout()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (auth.address === undefined) {
    const injected = connectors.find((c) => c.id !== 'privy')
    return (
      <div className="flex items-center gap-2">
        <Button variant="outline" busy={isPending} disabled={injected === undefined} onClick={() => injected !== undefined && connect({ connector: injected })}>
          Connect wallet
        </Button>
        <PrivyLogin />
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <Address value={auth.address} />
      {auth.signedIn ? (
        <Button variant="outline" onClick={() => { auth.signOut(); disconnect(); void privyLogout() }}>Sign out</Button>
      ) : (
        <Button
          busy={busy}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              await auth.signIn()
            } catch (e) {
              setError((e as Error).message.split('\n')[0] ?? 'sign-in failed')
            } finally {
              setBusy(false)
            }
          }}
        >
          Sign in
        </Button>
      )}
      {error !== null && <span className="text-xs text-red-600">{error}</span>}
    </div>
  )
}
