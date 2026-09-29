import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from 'react'
import { useAccount, useDisconnect, useSignMessage } from 'wagmi'
import { session, setSession, tool } from '../api.ts'
import { FundButton } from './Fund.tsx'
import { PrivyLogin, usePrivyLogout } from './Privy.tsx'
import { Address, Button } from './ui.tsx'

/** Which address the stored session belongs to, and until when (seconds): a session outlives the tab now. */
const OWNER_KEY = 'agent-jobs.session-owner'
type Owner = { address: string; expiresAt: number }
function readOwner(): Owner | null {
  try {
    return JSON.parse(localStorage.getItem(OWNER_KEY) ?? 'null') as Owner | null
  } catch {
    return null
  }
}
function writeOwner(owner: Owner | null) {
  try {
    if (owner === null) localStorage.removeItem(OWNER_KEY)
    else localStorage.setItem(OWNER_KEY, JSON.stringify(owner))
  } catch {
    // storage blocked: the session then lasts this tab only
  }
}

/**
 * Log in with Privy (email or social; an embedded wallet), then sign in to the board with SIWE (one signature). The
 * session counts only for the address that signed it and until it expires; a different wallet signs in afresh.
 */
export function useSignedIn() {
  const { address } = useAccount()
  const [token, setToken] = useState(session())
  const [owner, setOwner] = useState(readOwner())
  const { signMessageAsync } = useSignMessage()
  const signIn = async () => {
    if (address === undefined) throw new Error('log in first')
    const { message } = await tool<{ message: string }>('auth_challenge', { address })
    const signature = await signMessageAsync({ message })
    const r = await tool<{ session: string; address: string; expiresAt: number }>('auth_login', { message, signature })
    setSession(r.session)
    setToken(r.session)
    const o = { address: r.address, expiresAt: r.expiresAt }
    writeOwner(o)
    setOwner(o)
  }
  const signOut = () => {
    setSession(null)
    setToken(null)
    writeOwner(null)
    setOwner(null)
  }
  const ours =
    token !== null &&
    address !== undefined &&
    owner !== null &&
    owner.address.toLowerCase() === address.toLowerCase() &&
    owner.expiresAt * 1000 > Date.now()
  return { address, signedIn: ours, signIn, signOut }
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
  const { disconnect } = useDisconnect()
  const privyLogout = usePrivyLogout()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signIn = async () => {
    setBusy(true)
    setError(null)
    try {
      await auth.signIn()
    } catch (e) {
      setError((e as Error).message.split('\n')[0] ?? 'sign-in failed')
    } finally {
      setBusy(false)
    }
  }
  // Right after logging in, ask for the sign-in signature once per address and tab (declining leaves the button).
  const asked = useRef(new Set<string>())
  useEffect(() => {
    const a = auth.address?.toLowerCase()
    if (a === undefined || auth.signedIn || asked.current.has(a)) return
    asked.current.add(a)
    try {
      if (sessionStorage.getItem(`agent-jobs.asked:${a}`) !== null) return
      sessionStorage.setItem(`agent-jobs.asked:${a}`, '1')
    } catch {
      // no sessionStorage: ask once per page load
    }
    void signIn()
  }, [auth.address, auth.signedIn])
  if (auth.address === undefined) return <PrivyLogin />
  return (
    <div className="flex items-center gap-2">
      <Address value={auth.address} />
      <FundButton address={auth.address} />
      {auth.signedIn ? (
        <Button variant="outline" onClick={() => { auth.signOut(); disconnect(); void privyLogout() }}>Sign out</Button>
      ) : (
        <Button busy={busy} onClick={() => void signIn()}>
          Sign in
        </Button>
      )}
      {error !== null && <span className="text-xs text-red-600">{error}</span>}
    </div>
  )
}
