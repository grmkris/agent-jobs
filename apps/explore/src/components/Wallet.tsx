import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useAccount, useDisconnect, useSignMessage } from 'wagmi'
import { session, setSession, tool } from '../api.ts'
import { PrivyLogin, usePrivyLogout } from './Privy.tsx'
import { Button, cn } from './ui.tsx'

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

/**
 * Right after logging in, asks once per address and tab for the board's sign-in signature (declining leaves a Sign in
 * button). Call it once, in the shell; the account controls only display its state.
 */
export function useAutoSignIn(auth: ReturnType<typeof useSignedIn>) {
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
  return { busy, error, signIn }
}

export type AutoSignIn = ReturnType<typeof useAutoSignIn>

/** Signs out of the board and of Privy, and disconnects the wallet. */
export function useSignOut(auth: ReturnType<typeof useSignedIn>) {
  const { disconnect } = useDisconnect()
  const privyLogout = usePrivyLogout()
  return () => {
    auth.signOut()
    disconnect()
    void privyLogout()
  }
}

/**
 * Who is signed in, compactly: the login button, a Sign in button when the signature is still missing, or the
 * address. `full` adds Sign out (the sidebar); on a phone the address links to Me, where signing out lives.
 */
export function AccountControl({ auth, account, full = false }: { auth: ReturnType<typeof useSignedIn>; account: AutoSignIn; full?: boolean }) {
  const signOut = useSignOut(auth)
  if (auth.address === undefined) return <PrivyLogin />
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {auth.signedIn ? (
        <Link to="/me" className="flex min-w-0 items-center gap-2 rounded-full bg-fill py-1 pr-3 pl-1 text-[0.85rem] font-medium" aria-label="Your wallet">
          <Monogram seed={auth.address} />
          <span className="truncate font-mono text-[0.8rem]">{auth.address.slice(0, 6)}…{auth.address.slice(-4)}</span>
        </Link>
      ) : (
        <Button busy={account.busy} size="sm" onClick={() => void account.signIn()}>
          Sign in
        </Button>
      )}
      {/* Always a way out, even when the signature was declined. */}
      {full && (
        <Button variant="plain" size="sm" onClick={signOut}>
          Sign out
        </Button>
      )}
      {account.error !== null && <span className="basis-full text-xs text-bad">{account.error}</span>}
    </div>
  )
}

/** A round colour mark derived from an address or agent id, for people and agents without a picture. */
export function Monogram({ seed, label, size = 'sm' }: { seed: string; label?: string; size?: 'sm' | 'md' | 'lg' }) {
  // FNV-1a spreads neighbouring seeds (agent 1942, 1943…) across the colour wheel.
  let x = 0x811c9dc5
  for (const c of seed.toLowerCase()) x = Math.imul(x ^ c.charCodeAt(0), 0x01000193)
  const h = (x >>> 0) % 360
  return (
    <span
      aria-hidden
      className={cn('grid shrink-0 place-items-center rounded-full font-bold text-white', size === 'sm' && 'size-6 text-[0.6rem]', size === 'md' && 'size-9 text-[0.72rem]', size === 'lg' && 'size-16 text-lg')}
      style={{ background: `linear-gradient(140deg, hsl(${h} 62% 56%), hsl(${(h + 40) % 360} 58% 44%))` }}
    >
      {label ?? ''}
    </span>
  )
}
