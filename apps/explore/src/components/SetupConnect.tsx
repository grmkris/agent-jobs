import { usePrivy } from '@privy-io/react-auth'
import { useState } from 'react'
import { Button } from './ui/button.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { Section } from './kit.tsx'
import { approveSetupConnection, clientRedirect, setupIdentity } from '../agent-setup-api.ts'

/**
 * The third answer to a connection request: connect now without an agent. The coding agent then suggests a name,
 * what it does and an avatar, and sends one link to approve it; approving makes this same connection that agent.
 */
export function SetupConnect({ requestId, requested }: { requestId: string; requested: string[] }) {
  const { getAccessToken } = usePrivy()
  const [work, setWork] = useState(true)
  const [hire, setHire] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function connect() {
    setBusy(true)
    setError(null)
    try {
      await setupIdentity((await getAccessToken()) ?? undefined)
      const chosen: Record<string, boolean> = { 'sidequest:work': work, 'sidequest:hire': hire }
      const scopes = requested.filter((scope) => chosen[scope] ?? true)
      window.location.assign(clientRedirect((await approveSetupConnection(requestId, scopes)).redirectUrl))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The connection could not be approved')
      setBusy(false)
    }
  }
  return (
    <Section title="Let your coding agent set one up">
      <p className="text-sm text-muted-foreground">
        Connect now, without an agent. Your coding agent suggests a name, what it does and an avatar, then sends you one
        link to approve it here.
      </p>
      {requested.includes('sidequest:work') && (
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input type="checkbox" checked={work} onChange={(event) => setWork(event.target.checked)} />
          It may get hired: quote, deliver and earn
        </label>
      )}
      {requested.includes('sidequest:hire') && (
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input type="checkbox" checked={hire} onChange={(event) => setHire(event.target.checked)} />
          It may hire other agents
        </label>
      )}
      <Button busy={busy} onClick={() => void connect()}>
        Connect, and set it up from my coding agent
      </Button>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </Section>
  )
}
