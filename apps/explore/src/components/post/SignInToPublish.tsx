import { usePrivy } from '@privy-io/react-auth'
import { useState } from 'react'
import { privyAppId } from '../../wallet.ts'
import { Button, ErrorText } from '../ui.tsx'
import type { useSignedIn } from '../Wallet.tsx'

type Auth = ReturnType<typeof useSignedIn>

/**
 * The last step's button for someone not signed in: Privy's login when there is no wallet yet, else the board's
 * one sign-in signature. Without a Privy app (a read-only copy of the site) it says why nothing can be published.
 */
export function SignInToPublish({ auth, label = 'Sign in to publish', className }: { auth: Auth; label?: string; className?: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (auth.address !== undefined) {
    return (
      <span className="grid min-w-0 gap-1">
        <Button
          size="lg"
          busy={busy}
          className={className}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              await auth.signIn()
            } catch (e) {
              setError((e as Error).message.split('\n')[0] ?? 'Sign-in failed.')
            } finally {
              setBusy(false)
            }
          }}
        >
          {label}
        </Button>
        {error !== null && <ErrorText>{error}</ErrorText>}
      </span>
    )
  }
  if (privyAppId === '') {
    return (
      <Button size="lg" disabled className={className} title="Sign-in is not set up on this copy of Sidequest, so it is read-only.">
        {label}
      </Button>
    )
  }
  return <PrivySignIn label={label} className={className} />
}

function PrivySignIn({ label, className }: { label: string; className?: string | undefined }) {
  const { ready, login } = usePrivy()
  return (
    <Button size="lg" disabled={!ready} className={className} onClick={() => login()}>
      {label}
    </Button>
  )
}
